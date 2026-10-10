using System.Collections.Generic;
using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>Ground-plane A* with body clearance. Rebuild after moving obstacle colliders.</summary>
    [DisallowMultipleComponent]
    public sealed class GridNavigator : MonoBehaviour
    {
        [SerializeField] private Bounds bounds = new Bounds(Vector3.zero, new Vector3(28, 2, 34));
        [SerializeField, Min(0.25f)] private float cellSize = 0.65f;
        [SerializeField] private LayerMask obstacleMask = 1 << 9;
        [SerializeField, Min(0.1f)] private float clearance = 0.35f;
        [SerializeField, Min(0.8f)] private float actorHeight = 1.2f;

        private int width;
        private int depth;
        private bool[] walkable;
        private readonly List<int> open = new List<int>();
        private readonly List<Vector3> reversePath = new List<Vector3>();

        public void Configure(Bounds worldBounds, float size, int mask)
        {
            bounds = worldBounds;
            cellSize = Mathf.Max(0.25f, size);
            obstacleMask = mask;
            walkable = null;
        }

        public void Rebuild()
        {
            Physics.SyncTransforms();
            width = Mathf.Max(1, Mathf.FloorToInt(bounds.size.x / cellSize));
            depth = Mathf.Max(1, Mathf.FloorToInt(bounds.size.z / cellSize));
            walkable = new bool[width * depth];
            for (int index = 0; index < walkable.Length; index++)
            {
                Vector3 point = CellPoint(index);
                walkable[index] = InsideWithClearance(point) && IsBodyFree(point);
            }
        }

        public bool TryFindPath(Vector3 from, Vector3 to, List<Vector3> result)
        {
            result.Clear();
            if (walkable == null) Rebuild();
            from.y = to.y = bounds.center.y;
            if (!InsideWithClearance(from) || !InsideWithClearance(to) || !IsBodyFree(from) || !IsBodyFree(to))
                return false;
            if (SegmentClear(from, to))
            {
                result.Add(to);
                return true;
            }

            int start = CellIndex(from);
            int goal = CellIndex(to);
            if (!walkable[start] || !walkable[goal]) return false;
            if (!SegmentClear(from, CellPoint(start)) || !SegmentClear(CellPoint(goal), to)) return false;

            int count = walkable.Length;
            int[] cost = new int[count];
            int[] parent = new int[count];
            bool[] closed = new bool[count];
            for (int i = 0; i < count; i++)
            {
                cost[i] = int.MaxValue;
                parent[i] = -1;
            }
            open.Clear();
            open.Add(start);
            cost[start] = 0;

            while (open.Count > 0)
            {
                int bestPosition = 0;
                int bestScore = int.MaxValue;
                for (int i = 0; i < open.Count; i++)
                {
                    int score = cost[open[i]] + Heuristic(open[i], goal);
                    if (score < bestScore) { bestScore = score; bestPosition = i; }
                }
                int current = open[bestPosition];
                open.RemoveAt(bestPosition);
                if (current == goal)
                {
                    BuildPath(start, goal, parent, from, to, result);
                    return true;
                }
                closed[current] = true;
                int x = current % width;
                int z = current / width;

                for (int dz = -1; dz <= 1; dz++)
                for (int dx = -1; dx <= 1; dx++)
                {
                    if (dx == 0 && dz == 0) continue;
                    int nx = x + dx;
                    int nz = z + dz;
                    if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
                    int neighbor = nz * width + nx;
                    if (closed[neighbor] || !walkable[neighbor]) continue;
                    if (dx != 0 && dz != 0 && (!walkable[z * width + nx] || !walkable[nz * width + x]))
                        continue;
                    int nextCost = cost[current] + (dx != 0 && dz != 0 ? 14 : 10);
                    if (nextCost >= cost[neighbor]) continue;
                    // Continuous clearance check also handles thin or angled obstacles between cells.
                    if (!SegmentClear(CellPoint(current), CellPoint(neighbor))) continue;
                    if (cost[neighbor] == int.MaxValue) open.Add(neighbor);
                    cost[neighbor] = nextCost;
                    parent[neighbor] = current;
                }
            }
            return false;
        }

        public bool SegmentClear(Vector3 from, Vector3 to)
        {
            from.y = to.y = bounds.center.y;
            Vector3 delta = to - from;
            float distance = delta.magnitude;
            if (!IsBodyFree(from) || !IsBodyFree(to)) return false;
            if (distance < 0.001f) return true;
            BodyCapsule(from, out Vector3 bottom, out Vector3 top);
            return !Physics.CapsuleCast(bottom, top, clearance, delta / distance, distance,
                obstacleMask, QueryTriggerInteraction.Ignore);
        }

        private bool IsBodyFree(Vector3 position)
        {
            BodyCapsule(position, out Vector3 bottom, out Vector3 top);
            return !Physics.CheckCapsule(bottom, top, clearance, obstacleMask, QueryTriggerInteraction.Ignore);
        }

        private void BodyCapsule(Vector3 position, out Vector3 bottom, out Vector3 top)
        {
            bottom = position + Vector3.up * (clearance + 0.03f);
            top = position + Vector3.up * Mathf.Max(clearance + 0.03f, actorHeight - clearance);
        }

        private bool InsideWithClearance(Vector3 point)
        {
            return point.x >= bounds.min.x + clearance && point.x <= bounds.max.x - clearance
                && point.z >= bounds.min.z + clearance && point.z <= bounds.max.z - clearance;
        }

        private int CellIndex(Vector3 point)
        {
            int x = Mathf.Clamp(Mathf.FloorToInt((point.x - bounds.min.x) / cellSize), 0, width - 1);
            int z = Mathf.Clamp(Mathf.FloorToInt((point.z - bounds.min.z) / cellSize), 0, depth - 1);
            return z * width + x;
        }

        private Vector3 CellPoint(int index)
        {
            return new Vector3(bounds.min.x + (index % width + 0.5f) * cellSize,
                bounds.center.y, bounds.min.z + (index / width + 0.5f) * cellSize);
        }

        private int Heuristic(int a, int b)
        {
            int dx = Mathf.Abs(a % width - b % width);
            int dz = Mathf.Abs(a / width - b / width);
            return 14 * Mathf.Min(dx, dz) + 10 * Mathf.Abs(dx - dz);
        }

        private void BuildPath(int start, int goal, int[] parent, Vector3 from, Vector3 to, List<Vector3> result)
        {
            reversePath.Clear();
            reversePath.Add(to);
            for (int current = goal; current != -1; current = parent[current])
            {
                reversePath.Add(CellPoint(current));
                if (current == start) break;
            }
            reversePath.Reverse();
            Vector3 anchor = from;
            int next = 0;
            while (next < reversePath.Count)
            {
                int furthest = next;
                while (furthest + 1 < reversePath.Count && SegmentClear(anchor, reversePath[furthest + 1]))
                    furthest++;
                result.Add(reversePath[furthest]);
                anchor = reversePath[furthest];
                next = furthest + 1;
            }
        }
    }
}

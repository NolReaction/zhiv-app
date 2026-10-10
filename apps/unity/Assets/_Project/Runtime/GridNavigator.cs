using System;
using System.Collections.Generic;
using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>
    /// A* on a flat plane or Terrain, with lazy body-clearance checks and a binary heap.
    /// Rebuild invalidates cached cells/edges after editing ground or obstacles. SegmentClear always checks live physics.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class GridNavigator : MonoBehaviour
    {
        [SerializeField] private Bounds bounds = new Bounds(Vector3.zero, new Vector3(28, 2, 34));
        [SerializeField, Min(0.25f)] private float cellSize = 0.65f;
        [SerializeField] private LayerMask obstacleMask = 1 << 9;
        [SerializeField, Min(0.1f)] private float clearance = 0.35f;
        [SerializeField, Min(0.8f)] private float actorHeight = 1.2f;
        [SerializeField] private Terrain groundTerrain;
        [SerializeField, Range(0, 45)] private float maximumSlope = 45;
        [SerializeField, Tooltip("Optional convex boundary in world XZ. Empty uses the rectangular bounds.")]
        private Vector2[] walkablePolygon = Array.Empty<Vector2>();

        private const int MaximumCellCount = 262144;
        private const int SmoothingLookahead = 12;
        private const byte UnknownCell = 0;
        private const byte BlockedCell = 1;
        private const byte FreeCell = 2;
        private int width;
        private int depth;
        private bool gridReady;
        private byte[] cellState;
        private float[] cellHeight;
        private byte[] knownEdges;
        private byte[] freeEdges;
        private int[] cost;
        private int[] parent;
        private int[] visitedSearch;
        private int[] closedSearch;
        private int[] heap;
        private int[] heapPosition;
        private int heapCount;
        private int searchVersion;
        private int searchGoal;
        private readonly List<Vector3> reversePath = new List<Vector3>();

        public int LastExpandedCellCount { get; private set; }
        public double LastSearchMilliseconds { get; private set; }

        public void Configure(Bounds worldBounds, float size, int mask)
        {
            bounds = worldBounds;
            cellSize = Mathf.Max(0.25f, size);
            obstacleMask = mask;
            gridReady = false;
        }

        public void ConfigureTerrain(Terrain terrain)
        {
            groundTerrain = terrain;
            gridReady = false;
        }

        public void ConfigureWalkablePolygon(Vector2[] points)
        {
            if (!ValidPolygon(points))
                throw new ArgumentException("Walkable boundary must be empty or 3 to 8 distinct convex vertices in order.", nameof(points));
            walkablePolygon = points == null ? Array.Empty<Vector2>() : (Vector2[])points.Clone();
            gridReady = false;
        }

        private void OnValidate() => gridReady = false;

        public Vector3 ProjectToGround(Vector3 point)
        {
            if (!HasTerrain) point.y = bounds.center.y;
            else if (TerrainCoordinates(point, out _))
            {
                // SampleHeight takes world XZ, but returns height relative to the Terrain origin.
                point.y = groundTerrain.SampleHeight(point) + groundTerrain.transform.position.y;
            }
            // Outside a configured Terrain, preserve the point instead of sampling a clamped edge.
            // Navigation rejects these positions through InsideWithClearance.
            return point;
        }

        private bool HasTerrain => groundTerrain != null && groundTerrain.terrainData != null;

        public void Rebuild()
        {
            gridReady = false;
            if (!ValidGridDimensions(out int nextWidth, out int nextDepth))
            {
                Debug.LogError("GridNavigator needs finite positive bounds/cell size, a valid body size/convex boundary, " +
                    "and no more than " + MaximumCellCount + " cells. Increase cell size or reduce navigation bounds.", this);
                return;
            }
            Physics.SyncTransforms();
            width = nextWidth;
            depth = nextDepth;
            int count = width * depth;
            if (cellState == null || cellState.Length != count)
            {
                cellState = new byte[count];
                cellHeight = new float[count];
                knownEdges = new byte[count];
                freeEdges = new byte[count];
                cost = new int[count];
                parent = new int[count];
                visitedSearch = new int[count];
                closedSearch = new int[count];
                heap = new int[count];
                heapPosition = new int[count];
                searchVersion = 0;
            }
            else
            {
                Array.Clear(cellState, 0, count);
                Array.Clear(knownEdges, 0, count);
                Array.Clear(freeEdges, 0, count);
            }
            // No whole-map physics pass here. Each request evaluates only the cells it actually reaches.
            heapCount = 0;
            gridReady = true;
        }

        public bool TryFindPath(Vector3 from, Vector3 to, List<Vector3> result)
        {
            long started = System.Diagnostics.Stopwatch.GetTimestamp();
            LastExpandedCellCount = 0;
            try
            {
                return FindPath(from, to, result);
            }
            finally
            {
                LastSearchMilliseconds = (System.Diagnostics.Stopwatch.GetTimestamp() - started) *
                    1000d / System.Diagnostics.Stopwatch.Frequency;
            }
        }

        private bool FindPath(Vector3 from, Vector3 to, List<Vector3> result)
        {
            result.Clear();
            if (!gridReady) Rebuild();
            if (!gridReady || !Finite(from) || !Finite(to)) return false;
            from = ProjectToGround(from);
            to = ProjectToGround(to);
            if (!InsideWithClearance(from) || !InsideWithClearance(to)
                || !GroundWalkable(from) || !GroundWalkable(to) || !IsBodyFree(from) || !IsBodyFree(to))
                return false;
            if (SegmentClear(from, to))
            {
                result.Add(to);
                return true;
            }

            int start = CellIndex(from);
            int goal = CellIndex(to);
            if (!CellWalkable(start) || !CellWalkable(goal)) return false;
            if (!SegmentClear(from, CellPoint(start)) || !SegmentClear(CellPoint(goal), to)) return false;

            // Search stamps avoid clearing/allocating every cost/parent buffer on every click.
            if (searchVersion == int.MaxValue)
            {
                Array.Clear(visitedSearch, 0, visitedSearch.Length);
                Array.Clear(closedSearch, 0, closedSearch.Length);
                searchVersion = 0;
            }
            searchVersion++;
            searchGoal = goal;
            heapCount = 0;
            VisitCell(start);
            cost[start] = 0;
            PushOrDecrease(start);

            while (heapCount > 0)
            {
                int current = PopBest();
                LastExpandedCellCount++;
                if (current == goal)
                    return BuildPath(start, goal, from, to, result);
                closedSearch[current] = searchVersion;
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
                    if (closedSearch[neighbor] == searchVersion || !CellWalkable(neighbor)) continue;
                    if (dx != 0 && dz != 0 && (!CellWalkable(z * width + nx) || !CellWalkable(nz * width + x)))
                        continue;
                    VisitCell(neighbor);
                    int nextCost = cost[current] + (dx != 0 && dz != 0 ? 14 : 10);
                    if (nextCost >= cost[neighbor]) continue;
                    // Continuous clearance check also handles thin or angled obstacles between cells.
                    if (!AdjacentEdgeClear(current, neighbor, dx, dz)) continue;
                    cost[neighbor] = nextCost;
                    parent[neighbor] = current;
                    PushOrDecrease(neighbor);
                }
            }
            return false;
        }

        public bool SegmentClear(Vector3 from, Vector3 to)
        {
            if (!Finite(from) || !Finite(to)) return false;
            if (!InsideWithClearance(from) || !InsideWithClearance(to)) return false;
            from = ProjectToGround(from);
            to = ProjectToGround(to);
            if (!GroundWalkable(from) || !GroundWalkable(to) || !IsBodyFree(from)) return false;

            Vector2 horizontal = new Vector2(to.x - from.x, to.z - from.z);
            float distance = horizontal.magnitude;
            if (distance < 0.0001f) return IsBodyFree(to);

            // A flat map needs one sweep. On Terrain follow short ground-projected segments,
            // never the straight chord between distant hilltops or either side of a cliff.
            float spacing = 0.25f;
            if (HasTerrain)
            {
                Vector3 heightmapScale = groundTerrain.terrainData.heightmapScale;
                spacing = Mathf.Min(spacing, Mathf.Max(0.025f,
                    Mathf.Min(heightmapScale.x, heightmapScale.z) * 0.5f));
            }
            int steps = HasTerrain ? Mathf.Max(1, Mathf.CeilToInt(distance / spacing)) : 1;
            float maximumRisePerMeter = Mathf.Tan(maximumSlope * Mathf.Deg2Rad);
            Vector3 previous = from;
            for (int step = 1; step <= steps; step++)
            {
                Vector3 next = ProjectToGround(Vector3.Lerp(from, to, step / (float)steps));
                if (!GroundWalkable(next) || !IsBodyFree(next)) return false;
                Vector3 delta = next - previous;
                float horizontalStep = new Vector2(delta.x, delta.z).magnitude;
                if (Mathf.Abs(delta.y) > horizontalStep * maximumRisePerMeter + 0.0001f) return false;
                float stepDistance = delta.magnitude;
                if (stepDistance > 0.0001f)
                {
                    BodyCapsule(previous, out Vector3 bottom, out Vector3 top);
                    if (Physics.CapsuleCast(bottom, top, clearance, delta / stepDistance, stepDistance,
                        obstacleMask, QueryTriggerInteraction.Ignore)) return false;
                }
                previous = next;
            }
            return true;
        }

        private bool TerrainCoordinates(Vector3 point, out Vector2 normalized)
        {
            Vector3 local = point - groundTerrain.transform.position;
            Vector3 size = groundTerrain.terrainData.size;
            normalized = new Vector2(local.x / size.x, local.z / size.z);
            return normalized.x >= 0 && normalized.x <= 1 && normalized.y >= 0 && normalized.y <= 1;
        }

        private bool GroundWalkable(Vector3 point)
        {
            if (!HasTerrain) return true;
            if (!TerrainCoordinates(point, out Vector2 normalized)) return false;
            return groundTerrain.terrainData.GetSteepness(normalized.x, normalized.y) <= maximumSlope;
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
            if (point.x < bounds.min.x + clearance || point.x > bounds.max.x - clearance
                || point.z < bounds.min.z + clearance || point.z > bounds.max.z - clearance)
                return false;
            if (!InsidePolygon(point)) return false;
            if (!HasTerrain) return true;
            Vector3 origin = groundTerrain.transform.position;
            Vector3 size = groundTerrain.terrainData.size;
            return point.x >= origin.x + clearance && point.x <= origin.x + size.x - clearance
                && point.z >= origin.z + clearance && point.z <= origin.z + size.z - clearance;
        }

        private bool InsidePolygon(Vector3 point)
        {
            if (walkablePolygon == null || walkablePolygon.Length == 0) return true;
            if (walkablePolygon.Length < 3 || walkablePolygon.Length > 8) return false;
            Vector2 firstEdge = walkablePolygon[1] - walkablePolygon[0];
            float winding = Mathf.Sign(Cross(firstEdge, walkablePolygon[2] - walkablePolygon[1]));
            Vector2 position = new Vector2(point.x, point.z);
            for (int i = 0; i < walkablePolygon.Length; i++)
            {
                Vector2 a = walkablePolygon[i];
                Vector2 edge = walkablePolygon[(i + 1) % walkablePolygon.Length] - a;
                float distanceNumerator = Cross(edge, position - a) * winding;
                if (!Finite(distanceNumerator) || distanceNumerator < clearance * edge.magnitude) return false;
            }
            return true;
        }

        private int CellIndex(Vector3 point)
        {
            int x = Mathf.Clamp(Mathf.FloorToInt((point.x - bounds.min.x) / cellSize), 0, width - 1);
            int z = Mathf.Clamp(Mathf.FloorToInt((point.z - bounds.min.z) / cellSize), 0, depth - 1);
            return z * width + x;
        }

        private Vector3 CellPoint(int index)
        {
            Vector3 point = new Vector3(bounds.min.x + (index % width + 0.5f) * cellSize,
                bounds.center.y, bounds.min.z + (index / width + 0.5f) * cellSize);
            if (cellState[index] == UnknownCell) return ProjectToGround(point);
            point.y = cellHeight[index];
            return point;
        }

        private bool CellWalkable(int index)
        {
            if (cellState[index] != UnknownCell) return cellState[index] == FreeCell;
            Vector3 point = CellPoint(index);
            cellHeight[index] = point.y;
            bool available = InsideWithClearance(point) && GroundWalkable(point) && IsBodyFree(point);
            cellState[index] = available ? FreeCell : BlockedCell;
            return available;
        }

        private bool AdjacentEdgeClear(int from, int to, int dx, int dz)
        {
            int direction = (dz + 1) * 3 + dx + 1;
            if (direction > 4) direction--;
            int bit = 1 << direction;
            if ((knownEdges[from] & bit) != 0) return (freeEdges[from] & bit) != 0;
            bool clear = SegmentClear(CellPoint(from), CellPoint(to));
            int reverseBit = 1 << (7 - direction);
            knownEdges[from] |= (byte)bit;
            knownEdges[to] |= (byte)reverseBit;
            if (clear)
            {
                freeEdges[from] |= (byte)bit;
                freeEdges[to] |= (byte)reverseBit;
            }
            return clear;
        }

        private void VisitCell(int index)
        {
            if (visitedSearch[index] == searchVersion) return;
            visitedSearch[index] = searchVersion;
            cost[index] = int.MaxValue;
            parent[index] = -1;
            heapPosition[index] = -1;
        }

        private bool ComesBefore(int a, int b)
        {
            int aHeuristic = Heuristic(a, searchGoal);
            int bHeuristic = Heuristic(b, searchGoal);
            int aScore = cost[a] + aHeuristic;
            int bScore = cost[b] + bHeuristic;
            return aScore < bScore || (aScore == bScore &&
                (aHeuristic < bHeuristic || (aHeuristic == bHeuristic && a < b)));
        }

        private void PushOrDecrease(int index)
        {
            int position = heapPosition[index];
            if (position < 0) position = heapCount++;
            while (position > 0)
            {
                int above = (position - 1) / 2;
                if (!ComesBefore(index, heap[above])) break;
                heap[position] = heap[above];
                heapPosition[heap[position]] = position;
                position = above;
            }
            heap[position] = index;
            heapPosition[index] = position;
        }

        private int PopBest()
        {
            int best = heap[0];
            heapPosition[best] = -1;
            int last = heap[--heapCount];
            if (heapCount == 0) return best;
            int position = 0;
            while (position * 2 + 1 < heapCount)
            {
                int child = position * 2 + 1;
                if (child + 1 < heapCount && ComesBefore(heap[child + 1], heap[child])) child++;
                if (!ComesBefore(heap[child], last)) break;
                heap[position] = heap[child];
                heapPosition[heap[position]] = position;
                position = child;
            }
            heap[position] = last;
            heapPosition[last] = position;
            return best;
        }

        private bool ValidGridDimensions(out int columns, out int rows)
        {
            columns = rows = 0;
            if (!Finite(bounds.center) || !Finite(bounds.size) || !Finite(bounds.min) || !Finite(bounds.max)
                || !Finite(cellSize) || cellSize < 0.25f
                || bounds.size.x <= 0 || bounds.size.z <= 0 || !Finite(clearance) || clearance < 0.1f
                || !Finite(actorHeight) || actorHeight < clearance * 2 || !Finite(maximumSlope)
                || maximumSlope < 0 || maximumSlope > 45 || !ValidPolygon(walkablePolygon))
                return false;
            double columnsValue = Math.Max(1, Math.Floor((double)bounds.size.x / cellSize));
            double rowsValue = Math.Max(1, Math.Floor((double)bounds.size.z / cellSize));
            if (columnsValue * rowsValue > MaximumCellCount) return false;
            columns = (int)columnsValue;
            rows = (int)rowsValue;
            return true;
        }

        private static bool Finite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
        private static bool Finite(Vector3 value) => Finite(value.x) && Finite(value.y) && Finite(value.z);

        private static bool ValidPolygon(Vector2[] points)
        {
            if (points == null || points.Length == 0) return true;
            if (points.Length < 3 || points.Length > 8) return false;
            foreach (Vector2 point in points)
                if (!Finite(point.x) || !Finite(point.y)) return false;
            float firstTurn = Cross(points[1] - points[0], points[2] - points[1]);
            if (!Finite(firstTurn) || Mathf.Abs(firstTurn) < 0.0001f) return false;
            float winding = Mathf.Sign(firstTurn);
            for (int i = 0; i < points.Length; i++)
            {
                int next = (i + 1) % points.Length;
                Vector2 edge = points[next] - points[i];
                if (!Finite(edge.sqrMagnitude) || edge.sqrMagnitude < 0.0001f) return false;
                // Every other vertex must lie strictly on the inner side: excludes crossings and concave order.
                for (int j = 0; j < points.Length; j++)
                {
                    if (j == i || j == next) continue;
                    float side = Cross(edge, points[j] - points[i]) * winding;
                    if (!Finite(side) || side <= 0.0001f) return false;
                }
            }
            return true;
        }

        private static float Cross(Vector2 a, Vector2 b) => a.x * b.y - a.y * b.x;

        private int Heuristic(int a, int b)
        {
            int dx = Mathf.Abs(a % width - b % width);
            int dz = Mathf.Abs(a / width - b / width);
            return 14 * Mathf.Min(dx, dz) + 10 * Mathf.Abs(dx - dz);
        }

        private bool BuildPath(int start, int goal, Vector3 from, Vector3 to, List<Vector3> result)
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
                // Bound the sweep distance/count instead of repeatedly tracing ever longer prefixes of a route.
                int furthest = Mathf.Min(next + SmoothingLookahead - 1, reversePath.Count - 1);
                while (furthest >= next && !SegmentClear(anchor, reversePath[furthest])) furthest--;
                if (furthest < next)
                {
                    // Cached edges may be stale after a moving obstacle. Never return a partially valid route.
                    result.Clear();
                    return false;
                }
                result.Add(reversePath[furthest]);
                anchor = reversePath[furthest];
                next = furthest + 1;
            }
            return true;
        }
    }
}

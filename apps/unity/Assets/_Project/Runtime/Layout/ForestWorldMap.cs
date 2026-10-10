using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>Saved authoring references for the full forest; no runtime generation.</summary>
    [DisallowMultipleComponent]
    public sealed class ForestWorldMap : MonoBehaviour
    {
        public const int CurrentRevision = 2;
        public int Revision = CurrentRevision;
        public GroundAuthoring Ground;
        public ForestLandmark[] Places;
        public Vector2[] WalkBoundary;
        public int TreeCount;
        public int EditableTreeCount;
        public int ForestPatchCount;

        private void OnDrawGizmosSelected()
        {
            if (WalkBoundary == null || WalkBoundary.Length < 3) return;
            Gizmos.color = new Color(.9f, .75f, .3f);
            for (int i = 0; i < WalkBoundary.Length; i++)
            {
                Vector2 a = WalkBoundary[i], b = WalkBoundary[(i + 1) % WalkBoundary.Length];
                Gizmos.DrawLine(new Vector3(a.x, .3f, a.y), new Vector3(b.x, .3f, b.y));
            }
        }
    }
}

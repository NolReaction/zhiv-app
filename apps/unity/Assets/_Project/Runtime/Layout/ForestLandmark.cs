using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>Stable scene reference for an editable place and its walkable approach.</summary>
    [DisallowMultipleComponent]
    public sealed class ForestLandmark : MonoBehaviour
    {
        public string Id;
        public string DisplayName;
        public Vector2 Footprint = new Vector2(8, 8);
        public bool IsFuture;
        [TextArea] public string Purpose;
        [Tooltip("Move this child marker to the walkable ground in front of the place.")]
        public Transform Arrival;

        private void OnDrawGizmosSelected()
        {
            if (Arrival == null) return;
            Gizmos.color = new Color(.9f, .8f, .4f, .9f);
            Gizmos.DrawWireSphere(Arrival.position + Vector3.up * .15f, .4f);
            Gizmos.DrawLine(transform.position, Arrival.position);
            Gizmos.DrawWireCube(transform.position + Vector3.up * .1f, new Vector3(Footprint.x, .2f, Footprint.y));
        }
    }
}

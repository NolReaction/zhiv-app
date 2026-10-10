using System.Collections.Generic;
using UnityEngine;

namespace Zhiv.WorldPrototype
{
    [DisallowMultipleComponent]
    public sealed class WorldActorController : MonoBehaviour
    {
        [SerializeField] private GridNavigator navigator;
        [SerializeField, Min(0.1f)] private float speed = 2.8f;
        [SerializeField] private Transform visual;
        private readonly List<Vector3> path = new List<Vector3>();
        private readonly List<Vector3> candidatePath = new List<Vector3>();
        private int waypoint;
        private Vector3 visualRestPosition;
        private float walkTime;

        public bool IsMoving => waypoint < path.Count;

        public void Configure(GridNavigator nav) => navigator = nav;

        public void SetVisual(Transform target)
        {
            visual = target;
            if (visual != null) visualRestPosition = visual.localPosition;
        }

        private void Awake()
        {
            if (visual != null) visualRestPosition = visual.localPosition;
        }

        public bool MoveTo(Vector3 point)
        {
            if (navigator == null || !navigator.TryFindPath(transform.position, point, candidatePath)) return false;
            path.Clear();
            path.AddRange(candidatePath);
            waypoint = 0;
            return true;
        }

        private void Update()
        {
            if (IsMoving)
            {
                Vector3 target = path[waypoint];
                Vector3 movement = target - transform.position;
                movement.y = 0;
                if (movement.sqrMagnitude > 0.0025f)
                {
                    transform.rotation = Quaternion.RotateTowards(transform.rotation,
                        Quaternion.LookRotation(movement, Vector3.up), 540 * Time.deltaTime);
                    Vector3 next = Vector3.MoveTowards(transform.position, target, speed * Time.deltaTime);
                    // Keep a safe stop if an obstacle is edited or moved during Play Mode.
                    if (navigator.SegmentClear(transform.position, next)) transform.position = next;
                    else path.Clear();
                }
                else waypoint++;
            }

            if (visual == null) return;
            if (IsMoving) walkTime += Time.deltaTime * 12;
            float bounce = IsMoving ? Mathf.Abs(Mathf.Sin(walkTime)) * 0.075f : 0;
            visual.localPosition = Vector3.Lerp(visual.localPosition,
                visualRestPosition + Vector3.up * bounce, 15 * Time.deltaTime);
        }

        private void OnDisable()
        {
            path.Clear();
            waypoint = 0;
            if (visual != null) visual.localPosition = visualRestPosition;
        }
    }
}

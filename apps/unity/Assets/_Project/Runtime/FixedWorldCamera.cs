using System;
using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>Fixed viewing angle; dragging moves the camera on the ground plane.</summary>
    [DisallowMultipleComponent, RequireComponent(typeof(Camera))]
    [DefaultExecutionOrder(-30)]
    public sealed class FixedWorldCamera : MonoBehaviour
    {
        [SerializeField] private Vector3 focus;
        [SerializeField] private Bounds worldBounds = new Bounds(Vector3.zero, new Vector3(28, 2, 34));
        [SerializeField] private float initialSize = 11;
        [SerializeField] private float minimumSize = 4;
        [SerializeField] private float maximumSize = 18;
        [SerializeField] private Vector3 initialFocus;

        public event Action<Ray> Tapped;
        public Func<Vector2, bool> IsPointerBlocked { get; set; }

        private Camera worldCamera;
        private bool pointerActive;
        private bool dragging;
        private Vector2 pointerOrigin;
        private Vector2 previousPointer;
        private int activeFinger = -1;
        private bool multipleTouches;
        private bool pinchBlocked;
        private float previousPinchDistance;
        private Vector2 previousPinchCenter;
        private float suppressMouseUntil;

        public void Configure(Vector3 initialPoint, Bounds bounds, float size)
        {
            worldBounds = bounds;
            initialFocus = initialPoint;
            initialSize = Mathf.Clamp(size, minimumSize, maximumSize);
            ResetView();
        }

        public void ResetView()
        {
            EnsureCamera();
            focus = initialFocus;
            worldCamera.orthographicSize = initialSize;
            ApplyPose();
        }

        private void Awake()
        {
            EnsureCamera();
            ApplyPose();
        }

        private void EnsureCamera()
        {
            if (worldCamera == null) worldCamera = GetComponent<Camera>();
            worldCamera.orthographic = true;
        }

        private void Update()
        {
            if (Input.touchCount > 0)
            {
                suppressMouseUntil = Time.unscaledTime + 0.25f;
                UpdateTouches();
                return;
            }

            if (activeFinger != -1 || multipleTouches)
            {
                CancelGesture();
                multipleTouches = false;
                pinchBlocked = false;
            }
            if (Time.unscaledTime < suppressMouseUntil) return;

            Vector2 pointer = Input.mousePosition;
            if (Input.GetMouseButtonDown(0)) BeginPointer(pointer);
            if (Input.GetMouseButton(0)) MovePointer(pointer);
            if (Input.GetMouseButtonUp(0)) EndPointer(pointer, false);

            float scroll = Input.mouseScrollDelta.y;
            if (Mathf.Abs(scroll) > 0.001f && !Blocked(pointer))
                ZoomAt(pointer, worldCamera.orthographicSize * Mathf.Exp(-scroll * 0.12f));
        }

        private void UpdateTouches()
        {
            if (Input.touchCount >= 2)
            {
                Touch first = Input.GetTouch(0);
                Touch second = Input.GetTouch(1);
                Vector2 center = (first.position + second.position) * 0.5f;
                float distance = Vector2.Distance(first.position, second.position);
                if (!multipleTouches)
                {
                    pinchBlocked = Blocked(first.position) || Blocked(second.position);
                    multipleTouches = true;
                    pointerActive = false;
                    previousPinchDistance = distance;
                    previousPinchCenter = center;
                }
                else if (!pinchBlocked && distance > 1 && previousPinchDistance > 1)
                {
                    Pan(previousPinchCenter, center);
                    ZoomAt(center, worldCamera.orthographicSize * previousPinchDistance / distance);
                }
                previousPinchDistance = distance;
                previousPinchCenter = center;
                return;
            }

            // After a pinch, lift both fingers before beginning another tap or drag.
            if (multipleTouches) return;
            Touch touch = Input.GetTouch(0);
            if (touch.phase == TouchPhase.Began)
            {
                activeFinger = touch.fingerId;
                BeginPointer(touch.position);
            }
            if (touch.fingerId != activeFinger) return;
            if (touch.phase == TouchPhase.Moved || touch.phase == TouchPhase.Stationary)
                MovePointer(touch.position);
            if (touch.phase == TouchPhase.Ended || touch.phase == TouchPhase.Canceled)
            {
                EndPointer(touch.position, touch.phase == TouchPhase.Canceled);
                activeFinger = -1;
            }
        }

        private bool Blocked(Vector2 point)
        {
            return !Screen.safeArea.Contains(point) || (IsPointerBlocked?.Invoke(point) ?? false);
        }

        private void BeginPointer(Vector2 point)
        {
            pointerActive = !Blocked(point);
            dragging = false;
            pointerOrigin = previousPointer = point;
        }

        private void MovePointer(Vector2 point)
        {
            if (!pointerActive) return;
            float threshold = 8 * Mathf.Clamp(Screen.dpi / 160f, 1, 2);
            if (!dragging && (point - pointerOrigin).sqrMagnitude > threshold * threshold)
                dragging = true;
            if (dragging) Pan(previousPointer, point);
            previousPointer = point;
        }

        private void EndPointer(Vector2 point, bool canceled)
        {
            float threshold = 8 * Mathf.Clamp(Screen.dpi / 160f, 1, 2);
            if (pointerActive && !dragging && !canceled && !Blocked(point)
                && (point - pointerOrigin).sqrMagnitude <= threshold * threshold)
                Tapped?.Invoke(worldCamera.ScreenPointToRay(point));
            pointerActive = false;
            dragging = false;
        }

        private void Pan(Vector2 previous, Vector2 current)
        {
            if (!GroundPoint(previous, out Vector3 before) || !GroundPoint(current, out Vector3 after)) return;
            focus += before - after;
            ApplyPose();
        }

        private void ZoomAt(Vector2 point, float size)
        {
            bool hasBefore = GroundPoint(point, out Vector3 before);
            worldCamera.orthographicSize = Mathf.Clamp(size, minimumSize, maximumSize);
            if (hasBefore && GroundPoint(point, out Vector3 after)) focus += before - after;
            ApplyPose();
        }

        private bool GroundPoint(Vector2 point, out Vector3 hit)
        {
            Ray ray = worldCamera.ScreenPointToRay(point);
            Plane ground = new Plane(Vector3.up, new Vector3(0, worldBounds.center.y, 0));
            if (ground.Raycast(ray, out float distance))
            {
                hit = ray.GetPoint(distance);
                return true;
            }
            hit = default;
            return false;
        }

        private void ApplyPose()
        {
            focus.x = Mathf.Clamp(focus.x, worldBounds.min.x + 2, worldBounds.max.x - 2);
            focus.z = Mathf.Clamp(focus.z, worldBounds.min.z + 2, worldBounds.max.z - 2);
            focus.y = worldBounds.center.y;
            transform.rotation = Quaternion.Euler(45, 45, 0);
            transform.position = focus - transform.forward * 45;
        }

        private void CancelGesture()
        {
            pointerActive = false;
            dragging = false;
            activeFinger = -1;
            multipleTouches = false;
            pinchBlocked = false;
        }

        private void OnApplicationFocus(bool hasFocus)
        {
            if (!hasFocus) CancelGesture();
        }

        private void OnDisable() => CancelGesture();
    }
}

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
        [SerializeField] private float maximumSize = 15;
        [SerializeField] private Vector3 initialFocus;
        [SerializeField] private bool useTravelBounds;
        [SerializeField] private Bounds travelBounds;
        [SerializeField] private bool useCustomOverview;
        [SerializeField] private Vector3 overviewFocus;
        [SerializeField] private float overviewSize;

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
        private float requestedSize = -1;
        private float lastAspect = -1;
        private bool overviewActive;

        public void Configure(Vector3 initialPoint, Bounds bounds, float size)
        {
            if (!IsFinite(initialPoint) || !IsFinite(bounds.center) || !IsFinite(bounds.size)
                || bounds.size.x <= 0 || bounds.size.z <= 0 || !IsFinite(size) || size <= 0)
                throw new ArgumentException("Camera view requires a finite focus, positive size and X/Z bounds.");
            worldBounds = bounds;
            initialFocus = initialPoint;
            initialSize = Mathf.Clamp(size, minimumSize, maximumSize);
            ResetView();
        }

        public void ConfigureViewLimits(float min, float max)
        {
            if (!IsFinite(min) || !IsFinite(max) || min <= 0 || max < min)
                throw new ArgumentException("Camera zoom limits must be finite, positive and ordered.");
            minimumSize = min;
            maximumSize = max;
            initialSize = Mathf.Clamp(initialSize, min, max);
            EnsureCamera();
            requestedSize = Mathf.Clamp(requestedSize, min, max);
            ApplyPose();
        }

        /// <summary>Limits the camera centre independently of the terrain reserved behind the view.</summary>
        public void ConfigureTravelBounds(Bounds bounds)
        {
            if (!IsFinite(bounds.center) || !IsFinite(bounds.size) || bounds.size.x <= 0 || bounds.size.z <= 0)
                throw new ArgumentException("Camera travel bounds require finite, positive X/Z dimensions.", nameof(bounds));
            travelBounds = bounds;
            useTravelBounds = true;
            ApplyPose();
        }

        /// <summary>Enables an explicit wide overview. Selecting a place returns to the authored close view.</summary>
        public void ConfigureOverview(Vector3 center, float size)
        {
            if (!IsFinite(center) || !IsFinite(size) || size <= 0)
                throw new ArgumentException("Overview requires a finite centre and a positive size.");
            overviewFocus = center;
            overviewSize = Mathf.Max(minimumSize, size);
            useCustomOverview = true;
        }

        /// <summary>Focuses a place; large worlds return from overview to their authored close zoom.</summary>
        public void FocusOn(Vector3 point)
        {
            if (!IsFinite(point)) throw new ArgumentException("Camera focus must be finite.", nameof(point));
            CancelGesture();
            focus = point;
            if (useCustomOverview)
            {
                overviewActive = false;
                requestedSize = initialSize;
            }
            ApplyPose();
        }

        /// <summary>Uses the widest permitted view centred on the terrain, with no exposed ground edge.</summary>
        public void ShowOverview()
        {
            CancelGesture();
            EnsureCamera();
            overviewActive = useCustomOverview;
            focus = useCustomOverview ? overviewFocus : worldBounds.center;
            requestedSize = useCustomOverview ? overviewSize : maximumSize;
            ApplyPose();
        }

        public void ResetView()
        {
            CancelGesture();
            EnsureCamera();
            focus = initialFocus;
            overviewActive = false;
            requestedSize = initialSize;
            ApplyPose();
        }

        private void Awake()
        {
            // Start from the authored view, not the aspect-dependent size saved by the Editor.
            ResetView();
        }

        private void EnsureCamera()
        {
            if (worldCamera == null) worldCamera = GetComponent<Camera>();
            worldCamera.orthographic = true;
            if (requestedSize <= 0 || !IsFinite(requestedSize))
                requestedSize = worldCamera.orthographicSize;
            // A newly added camera can have no valid render target yet in an Editor menu command.
            // Leave a valid aspect untouched so Unity continues to follow Game view/device resizing.
            if (!IsFinite(worldCamera.aspect) || worldCamera.aspect <= 0)
                worldCamera.ResetAspect();
        }

        private void Update()
        {
            if (!Mathf.Approximately(lastAspect, worldCamera.aspect)) ApplyPose();
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
            float limit = overviewActive ? Mathf.Max(maximumSize, overviewSize) : maximumSize;
            requestedSize = Mathf.Clamp(size, minimumSize, limit);
            if (requestedSize <= maximumSize) overviewActive = false;
            ApplyPose();
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
            EnsureCamera();
            focus.y = worldBounds.center.y;
            transform.rotation = Quaternion.Euler(45, 45, 0);
            float zoomLimit = overviewActive ? Mathf.Max(maximumSize, overviewSize) : maximumSize;
            worldCamera.orthographicSize = Mathf.Clamp(requestedSize, minimumSize, zoomLimit);
            // At overview scale a fixed distance would put the bottom orthographic rays below ground.
            float distance = Mathf.Max(45, worldCamera.orthographicSize * 2 + 30);
            worldCamera.farClipPlane = Mathf.Max(worldCamera.farClipPlane, distance * 2 + worldBounds.size.y + 20);
            transform.position = focus - transform.forward * distance;

            if (GroundFootprint(out Vector2 minimum, out Vector2 maximum))
            {
                Vector2 span = maximum - minimum;
                float fit = Mathf.Min(worldBounds.size.x / span.x, worldBounds.size.z / span.y);
                if (fit < 1)
                {
                    // Containing the full viewport wins over the zoom-in limit on very wide screens.
                    // Keep requestedSize so rotating back restores the user's chosen zoom.
                    worldCamera.orthographicSize *= fit * 0.9999f;
                    GroundFootprint(out minimum, out maximum);
                }

                float minimumX = worldBounds.min.x - (minimum.x - focus.x);
                float maximumX = worldBounds.max.x - (maximum.x - focus.x);
                float minimumZ = worldBounds.min.z - (minimum.y - focus.z);
                float maximumZ = worldBounds.max.z - (maximum.y - focus.z);
                if (useTravelBounds)
                {
                    focus.x = Mathf.Clamp(focus.x, travelBounds.min.x, travelBounds.max.x);
                    focus.z = Mathf.Clamp(focus.z, travelBounds.min.z, travelBounds.max.z);
                }
                // Physical containment wins if an authored travel bound lies beyond the terrain.
                focus.x = ClampOrCenter(focus.x, minimumX, maximumX);
                focus.z = ClampOrCenter(focus.z, minimumZ, maximumZ);
                transform.position = focus - transform.forward * distance;
            }
            lastAspect = worldCamera.aspect;
        }

        private bool GroundFootprint(out Vector2 minimum, out Vector2 maximum)
        {
            minimum = new Vector2(float.PositiveInfinity, float.PositiveInfinity);
            maximum = new Vector2(float.NegativeInfinity, float.NegativeInfinity);
            Plane ground = new Plane(Vector3.up, new Vector3(0, worldBounds.center.y, 0));
            // Use all four viewport corners: a safe-area-only bound would still expose void
            // behind the transparent HUD or phone cutout. The UI delegate only blocks input.
            for (int corner = 0; corner < 4; corner++)
            {
                Ray ray = worldCamera.ViewportPointToRay(new Vector3(corner & 1, corner >> 1, 0));
                if (!ground.Raycast(ray, out float distance)) return false;
                Vector3 hit = ray.GetPoint(distance);
                minimum = Vector2.Min(minimum, new Vector2(hit.x, hit.z));
                maximum = Vector2.Max(maximum, new Vector2(hit.x, hit.z));
            }
            return true;
        }

        private static float ClampOrCenter(float value, float minimum, float maximum)
            => minimum <= maximum ? Mathf.Clamp(value, minimum, maximum) : (minimum + maximum) * 0.5f;

        private static bool IsFinite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
        private static bool IsFinite(Vector3 value) => IsFinite(value.x) && IsFinite(value.y) && IsFinite(value.z);

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

using UnityEngine;

namespace Zhiv.WorldPrototype.UI
{
    /// <summary>Fits a centred HUD column to the device safe area, including resize and rotation.</summary>
    [ExecuteAlways, DisallowMultipleComponent, RequireComponent(typeof(RectTransform))]
    [DefaultExecutionOrder(-100)]
    public sealed class SafeAreaLayout : MonoBehaviour
    {
        [SerializeField] private RectTransform content;
        [SerializeField, Min(280)] private float maximumWidth = 560;
        [SerializeField] private RectTransform[] floatingPanels;
        [SerializeField] private float[] preferredHeights;
        private Rect lastSafeArea;
        private Vector2 lastScreenSize;
        private Vector2 lastParentSize;

        public void Configure(RectTransform column, RectTransform[] panels = null)
        {
            content = column;
            floatingPanels = panels;
            preferredHeights = panels != null ? new float[panels.Length] : null;
            if (panels != null)
                for (int i = 0; i < panels.Length; i++) preferredHeights[i] = panels[i].sizeDelta.y;
            Apply();
        }

        private void OnEnable() => Apply();
        private void Update()
        {
            RectTransform parent = transform.parent as RectTransform;
            Vector2 parentSize = parent != null ? parent.rect.size : Vector2.zero;
            if (lastSafeArea != Screen.safeArea || lastScreenSize != new Vector2(Screen.width, Screen.height)
                || lastParentSize != parentSize) Apply();
        }

        private void Apply()
        {
            if (Screen.width <= 0 || Screen.height <= 0) return;
            RectTransform rect = (RectTransform)transform;
            RectTransform parent = transform.parent as RectTransform;
            Rect safe = Screen.safeArea;
            rect.anchorMin = new Vector2(safe.xMin / Screen.width, safe.yMin / Screen.height);
            rect.anchorMax = new Vector2(safe.xMax / Screen.width, safe.yMax / Screen.height);
            rect.offsetMin = rect.offsetMax = Vector2.zero;
            if (content != null)
            {
                float parentWidth = parent != null ? parent.rect.width : Screen.width;
                float safeWidth = parentWidth * safe.width / Screen.width;
                content.anchorMin = new Vector2(0.5f, 0);
                content.anchorMax = new Vector2(0.5f, 1);
                content.pivot = new Vector2(0.5f, 0.5f);
                content.sizeDelta = new Vector2(Mathf.Min(maximumWidth, Mathf.Max(0, safeWidth - 24)), 0);
                content.anchoredPosition = Vector2.zero;
            }
            if (floatingPanels != null && preferredHeights != null)
            {
                float parentHeight = parent != null ? parent.rect.height : Screen.height;
                float available = parentHeight * safe.height / Screen.height - 194;
                for (int i = 0; i < Mathf.Min(floatingPanels.Length, preferredHeights.Length); i++)
                {
                    RectTransform panel = floatingPanels[i];
                    if (panel != null) panel.SetSizeWithCurrentAnchors(RectTransform.Axis.Vertical,
                        Mathf.Min(preferredHeights[i], Mathf.Max(180, available)));
                }
            }
            lastSafeArea = safe;
            lastScreenSize = new Vector2(Screen.width, Screen.height);
            lastParentSize = parent != null ? parent.rect.size : Vector2.zero;
        }
    }
}

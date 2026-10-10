using UnityEngine;
using UnityEngine.UI;

namespace Zhiv.WorldPrototype.UI
{
    /// <summary>A schematic of authored places. It moves the camera without issuing a walking order.</summary>
    [DisallowMultipleComponent]
    public sealed class ForestMapPanel : MonoBehaviour
    {
        [SerializeField] private ForestHud hud;
        [SerializeField] private FixedWorldCamera worldCamera;
        [SerializeField] private GameObject overlay;
        [SerializeField] private RectTransform mapViewport;
        [SerializeField] private RectTransform mapContent;
        [SerializeField] private ForestLandmark[] landmarks;
        [SerializeField] private RectTransform[] markers;
        [SerializeField] private Text[] markerLabels;
        private Vector2 previousViewportSize;

        public void Configure(ForestHud forestHud, FixedWorldCamera camera, GameObject panel,
            RectTransform viewport, RectTransform content, ForestLandmark[] places,
            RectTransform[] placeMarkers, Text[] labels)
        {
            hud = forestHud;
            worldCamera = camera;
            overlay = panel;
            mapViewport = viewport;
            mapContent = content;
            landmarks = places;
            markers = placeMarkers;
            markerLabels = labels;
            RefreshMarkers();
        }

        public void Open()
        {
            if (overlay == null) return;
            hud?.ClosePanels();
            overlay.SetActive(true);
            Canvas.ForceUpdateCanvases();
            RefreshMarkers();
            ScrollRect scroll = mapViewport != null ? mapViewport.GetComponent<ScrollRect>() : null;
            if (scroll != null)
            {
                scroll.verticalNormalizedPosition = .5f;
                scroll.horizontalNormalizedPosition = .5f;
            }
        }

        public void Close()
        {
            if (overlay != null) overlay.SetActive(false);
        }

        public void FocusLandmark(int index)
        {
            if (landmarks == null || index < 0 || index >= landmarks.Length || landmarks[index] == null) return;
            worldCamera?.FocusOn(landmarks[index].transform.position);
            Close();
        }

        private void LateUpdate()
        {
            if (overlay != null && overlay.activeInHierarchy && mapViewport != null
                && mapViewport.rect.size != previousViewportSize) RefreshMarkers();
        }

        private void RefreshMarkers()
        {
            if (mapViewport == null || mapContent == null || landmarks == null || markers == null) return;
            previousViewportSize = mapViewport.rect.size;
            // Keep place labels readable when the phone rotates: short/narrow views can scroll.
            float mapHeight = Mathf.Max(560, mapViewport.rect.height);
            float mapWidth = Mathf.Max(300, mapViewport.rect.width);
            mapContent.SetSizeWithCurrentAnchors(RectTransform.Axis.Horizontal, mapWidth);
            mapContent.SetSizeWithCurrentAnchors(RectTransform.Axis.Vertical, mapHeight);
            for (int i = 0; i < Mathf.Min(landmarks.Length, markers.Length); i++)
            {
                RectTransform marker = markers[i];
                ForestLandmark landmark = landmarks[i];
                if (marker == null) continue;
                marker.gameObject.SetActive(landmark != null);
                if (landmark == null) continue;
                Vector3 position = landmark.transform.position;
                // The ground recipe's logical U/V axes are rotated 45 degrees into world X/Z.
                float u = (position.x - position.z) * .70710678f;
                float v = (position.x + position.z) * .70710678f;
                Vector2 anchor = new Vector2(Mathf.Lerp(.1f, .9f, Mathf.Clamp01((u + 64) / 128)),
                    Mathf.Lerp(.08f, .92f, Mathf.Clamp01((v + 72) / 144)));
                marker.anchorMin = marker.anchorMax = anchor;
                marker.anchoredPosition = Vector2.zero;
                marker.sizeDelta = new Vector2(Mathf.Clamp(mapWidth * .23f, 64, 104), 48);
                if (markerLabels != null && i < markerLabels.Length && markerLabels[i] != null)
                    markerLabels[i].text = landmark.DisplayName;
            }
        }
    }
}

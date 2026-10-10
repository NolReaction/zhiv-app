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
        [SerializeField] private RectTransform[] legendRows;
        [SerializeField] private Text[] legendLabels;
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
                scroll.verticalNormalizedPosition = 1f;
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
            EnsureLegend();
            // Names stay in a separate list: nearby home, bush, camp and warehouse pins remain distinct.
            // Short/narrow views retain the existing scroll rather than shrinking touch targets further.
            float mapHeight = Mathf.Max(660, mapViewport.rect.height);
            float mapWidth = Mathf.Max(340, mapViewport.rect.width);
            mapContent.SetSizeWithCurrentAnchors(RectTransform.Axis.Horizontal, mapWidth);
            mapContent.SetSizeWithCurrentAnchors(RectTransform.Axis.Vertical, mapHeight + 40 + landmarks.Length * 48);
            for (int i = 0; i < Mathf.Min(landmarks.Length, markers.Length); i++)
            {
                RectTransform marker = markers[i];
                ForestLandmark landmark = landmarks[i];
                if (marker == null) continue;
                marker.gameObject.SetActive(landmark != null);
                if (legendRows != null && i < legendRows.Length && legendRows[i] != null)
                    legendRows[i].gameObject.SetActive(landmark != null);
                if (landmark == null) continue;
                Vector3 position = landmark.transform.position;
                // The ground recipe's logical U/V axes are rotated 45 degrees into world X/Z.
                float u = (position.x - position.z) * .70710678f;
                float v = (position.x + position.z) * .70710678f;
                Vector2 anchor = new Vector2(Mathf.Lerp(.1f, .9f, Mathf.Clamp01((u + 64) / 128)),
                    Mathf.Lerp(.08f, .92f, Mathf.Clamp01((v + 72) / 144)));
                marker.anchorMin = marker.anchorMax = new Vector2(0, 1);
                marker.pivot = new Vector2(.5f, .5f);
                marker.anchoredPosition = new Vector2(anchor.x * mapWidth, -(1f - anchor.y) * mapHeight);
                marker.sizeDelta = new Vector2(32, 32);
                if (markerLabels != null && i < markerLabels.Length && markerLabels[i] != null)
                {
                    markerLabels[i].text = (i + 1).ToString("00");
                    markerLabels[i].fontSize = 14;
                    markerLabels[i].resizeTextForBestFit = false;
                }
                if (legendRows == null || i >= legendRows.Length || legendRows[i] == null) continue;
                RectTransform row = legendRows[i];
                row.gameObject.SetActive(true);
                row.anchorMin = row.anchorMax = new Vector2(.5f, 1);
                row.pivot = new Vector2(.5f, 1);
                row.anchoredPosition = new Vector2(0, -mapHeight - 24 - i * 48);
                row.sizeDelta = new Vector2(Mathf.Min(mapWidth - 24, Mathf.Max(180, mapViewport.rect.width - 24)), 44);
                if (legendLabels != null && i < legendLabels.Length && legendLabels[i] != null)
                    legendLabels[i].text = (i + 1).ToString("00") + " · " + PlaceName(landmark);
            }
        }

        private void EnsureLegend()
        {
            if (legendRows != null && legendRows.Length == landmarks.Length) return;
            if (legendRows != null)
                foreach (RectTransform row in legendRows)
                    if (row != null)
                    {
                        if (Application.isPlaying) Destroy(row.gameObject);
                        else DestroyImmediate(row.gameObject);
                    }
            // Reuse each marker's saved focus listener. This also upgrades older authored scenes
            // without replacing their panel, camera references or custom button colours.
            legendRows = new RectTransform[landmarks.Length];
            legendLabels = new Text[landmarks.Length];
            for (int i = 0; i < Mathf.Min(landmarks.Length, markers.Length); i++)
            {
                if (markers[i] == null) continue;
                RectTransform row = Instantiate(markers[i], mapContent);
                row.name = "Map place list " + (i + 1).ToString("00");
                Image background = row.GetComponent<Image>();
                if (background != null) background.sprite = null;
                Text label = row.GetComponentInChildren<Text>(true);
                if (label != null)
                {
                    label.fontSize = 15;
                    label.resizeTextForBestFit = false;
                    label.alignment = TextAnchor.MiddleLeft;
                    label.rectTransform.offsetMin = new Vector2(12, 3);
                    label.rectTransform.offsetMax = new Vector2(-8, -3);
                }
                legendRows[i] = row;
                legendLabels[i] = label;
            }
        }

        private static string PlaceName(ForestLandmark landmark)
        {
            string name = string.IsNullOrWhiteSpace(landmark.DisplayName)
                ? (string.IsNullOrWhiteSpace(landmark.Id) ? "Место" : landmark.Id)
                : landmark.DisplayName.Trim();
            int separator = name.IndexOf('·');
            if (separator > 0 && int.TryParse(name.Substring(0, separator).Trim(), out _))
                return name.Substring(separator + 1).Trim();
            return name;
        }
    }
}

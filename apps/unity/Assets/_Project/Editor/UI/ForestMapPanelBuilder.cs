using System;
using UnityEditor.Events;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;
using Zhiv.WorldPrototype;
using Zhiv.WorldPrototype.UI;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Creates a saved, editable map panel next to the ordinary forest HUD.</summary>
    public static class ForestMapPanelBuilder
    {
        private static readonly Color Cream = new Color(.95f, .91f, .77f);
        private static readonly Color Muted = new Color(.72f, .79f, .65f);

        public static GameObject Create(ForestHud hud, FixedWorldCamera camera, ForestLandmark[] landmarks)
        {
            if (hud == null || camera == null || landmarks == null)
                throw new ArgumentException("A forest map requires its HUD, camera and authored places.");
            Transform column = hud.transform.Find("Safe Area/Content Column");
            if (column == null) throw new InvalidOperationException("The forest HUD's safe content column is missing.");
            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            ForestMapPanel controller = hud.gameObject.AddComponent<ForestMapPanel>();
            Button open = Button("Map Button", column, "Карта", font, controller.Open);
            Place((RectTransform)open.transform, new Vector2(0, 1), new Vector2(0, 1),
                new Vector2(0, -141), new Vector2(94, -97));
            hud.RegisterPointerPanel((RectTransform)open.transform);

            RectTransform overlay = Rect("Map Overlay", hud.transform);
            Place(overlay, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
            overlay.gameObject.AddComponent<Image>().color = new Color(.025f, .045f, .03f, .97f);
            hud.RegisterPointerPanel(overlay);
            RectTransform safeArea = Rect("Map Safe Area", overlay);
            RectTransform mapColumn = Rect("Map Content Column", safeArea);
            safeArea.gameObject.AddComponent<SafeAreaLayout>().Configure(mapColumn);

            Text title = Label("Map Title", mapColumn, "Карта леса", font, 23, Cream);
            Place(title.rectTransform, new Vector2(0, 1), Vector2.one,
                new Vector2(10, -52), new Vector2(-62, -12));
            title.alignment = TextAnchor.MiddleLeft;
            Button close = Button("Close Map", mapColumn, "×", font, controller.Close);
            Place((RectTransform)close.transform, Vector2.one, Vector2.one,
                new Vector2(-46, -54), new Vector2(-2, -10));
            Text description = Label("Map Description", mapColumn,
                "Выбери место, чтобы осмотреть его ближе", font, 14, Muted);
            Place(description.rectTransform, new Vector2(0, 1), Vector2.one,
                new Vector2(10, -88), new Vector2(-10, -56));

            RectTransform viewport = Rect("Map Viewport", mapColumn);
            Place(viewport, Vector2.zero, Vector2.one, new Vector2(0, 66), new Vector2(0, -98));
            viewport.gameObject.AddComponent<Image>().color = new Color(.09f, .17f, .105f);
            viewport.gameObject.AddComponent<RectMask2D>();
            RectTransform content = Rect("Map Places", viewport);
            content.anchorMin = new Vector2(0, 1);
            content.anchorMax = Vector2.one;
            content.pivot = new Vector2(.5f, 1);
            content.sizeDelta = new Vector2(0, 560);
            content.anchoredPosition = Vector2.zero;
            ScrollRect scroll = viewport.gameObject.AddComponent<ScrollRect>();
            scroll.viewport = viewport;
            scroll.content = content;
            scroll.horizontal = true;
            scroll.vertical = true;
            scroll.movementType = ScrollRect.MovementType.Clamped;
            scroll.scrollSensitivity = 24;
            scroll.inertia = true;

            RectTransform[] markers = new RectTransform[landmarks.Length];
            Text[] labels = new Text[landmarks.Length];
            for (int i = 0; i < landmarks.Length; i++)
            {
                string name = landmarks[i] != null ? landmarks[i].DisplayName : "Место";
                Button marker = Button($"Place {i + 1:00}", content, name, font, null);
                markers[i] = (RectTransform)marker.transform;
                labels[i] = marker.GetComponentInChildren<Text>();
                labels[i].fontSize = 12;
                labels[i].resizeTextForBestFit = true;
                labels[i].resizeTextMinSize = 10;
                labels[i].resizeTextMaxSize = 12;
                UnityEventTools.AddIntPersistentListener(marker.onClick, controller.FocusLandmark, i);
            }

            Text note = Label("Map Note", mapColumn,
                "Поляны и места будущих построек\nКарта показывает расположение; герой остаётся на месте.", font, 12, Muted);
            Place(note.rectTransform, Vector2.zero, new Vector2(1, 0),
                new Vector2(6, 10), new Vector2(-6, 58));
            controller.Configure(hud, camera, overlay.gameObject, viewport, content, landmarks, markers, labels);
            overlay.gameObject.SetActive(false);
            return overlay.gameObject;
        }

        private static RectTransform Rect(string name, Transform parent)
        {
            GameObject item = new GameObject(name, typeof(RectTransform));
            item.transform.SetParent(parent, false);
            return (RectTransform)item.transform;
        }

        private static Text Label(string name, Transform parent, string value, Font font, int size, Color color)
        {
            Text text = Rect(name, parent).gameObject.AddComponent<Text>();
            text.font = font;
            text.text = value;
            text.fontSize = size;
            text.color = color;
            text.alignment = TextAnchor.MiddleCenter;
            text.horizontalOverflow = HorizontalWrapMode.Wrap;
            text.verticalOverflow = VerticalWrapMode.Truncate;
            text.raycastTarget = false;
            text.supportRichText = false;
            return text;
        }

        private static Button Button(string name, Transform parent, string value, Font font, UnityAction action)
        {
            RectTransform rect = Rect(name, parent);
            Image image = rect.gameObject.AddComponent<Image>();
            image.color = Color.white;
            Button button = rect.gameObject.AddComponent<Button>();
            button.targetGraphic = image;
            button.navigation = new Navigation { mode = Navigation.Mode.None };
            ColorBlock colors = button.colors;
            colors.normalColor = new Color(.18f, .28f, .17f);
            colors.highlightedColor = new Color(.26f, .36f, .2f);
            colors.pressedColor = new Color(.36f, .43f, .25f);
            colors.selectedColor = colors.normalColor;
            colors.fadeDuration = .08f;
            button.colors = colors;
            Outline outline = rect.gameObject.AddComponent<Outline>();
            outline.effectColor = new Color(.56f, .62f, .39f, .65f);
            outline.effectDistance = new Vector2(1, -1);
            Text label = Label("Label", rect, value, font, 15, Cream);
            Place(label.rectTransform, Vector2.zero, Vector2.one, new Vector2(4, 3), new Vector2(-4, -3));
            if (action != null) UnityEventTools.AddPersistentListener(button.onClick, action);
            return button;
        }

        private static void Place(RectTransform rect, Vector2 minimum, Vector2 maximum, Vector2 lower, Vector2 upper)
        {
            rect.anchorMin = minimum;
            rect.anchorMax = maximum;
            rect.offsetMin = lower;
            rect.offsetMax = upper;
        }
    }
}

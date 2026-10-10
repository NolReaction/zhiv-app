using System;
using UnityEditor.Events;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using Zhiv.WorldPrototype;
using Zhiv.WorldPrototype.UI;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Creates real, editable scene UI once. No UI generation runs in the player.</summary>
    public static class ForestHudBuilder
    {
        private static readonly Color Cream = new Color(0.95f, 0.91f, 0.77f);
        private static readonly Color Muted = new Color(0.72f, 0.79f, 0.65f);
        private static readonly Color PanelColor = new Color(0.055f, 0.11f, 0.08f, 0.96f);
        private static readonly Color ButtonColor = new Color(0.15f, 0.23f, 0.16f, 1);
        private static readonly Color Edge = new Color(0.49f, 0.55f, 0.36f, 0.75f);

        public static GameObject Create(DemoInteraction interaction, FixedWorldCamera camera,
            Transform home, Transform workshop, Transform shore)
        {
            if (interaction == null || camera == null) throw new ArgumentException("The HUD requires its interaction and camera.");
            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            if (font == null) throw new InvalidOperationException("Unity's built-in LegacyRuntime.ttf was not found.");
            GameObject root = new GameObject("Forest HUD", typeof(RectTransform), typeof(Canvas),
                typeof(CanvasScaler), typeof(GraphicRaycaster), typeof(ForestHud));
            Canvas canvas = root.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 20;
            CanvasScaler scaler = root.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(430, 900);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;
            ForestHud hud = root.GetComponent<ForestHud>();

            RectTransform safeArea = Rect("Safe Area", root.transform);
            RectTransform column = Rect("Content Column", safeArea);
            safeArea.gameObject.AddComponent<SafeAreaLayout>().Configure(column);

            RectTransform header = Panel("Header", column, 76, 12, true);
            Text title = Label("Title", header, "Живой лес", font, 23, Cream, TextAnchor.MiddleLeft);
            Place(title.rectTransform, new Vector2(0, 1), new Vector2(1, 1), new Vector2(16, -39), new Vector2(-70, -6));
            Text subtitle = Label("Layout Badge", header, "ПЛАНИРОВКА", font, 11, Muted, TextAnchor.MiddleLeft);
            Place(subtitle.rectTransform, new Vector2(0, 1), new Vector2(1, 1), new Vector2(17, -63), new Vector2(-70, -41));
            Button helpButton = Button("Help Button", header, "?", font, hud.ToggleHelp);
            Place((RectTransform)helpButton.transform, new Vector2(1, 0.5f), new Vector2(1, 0.5f),
                new Vector2(-59, -22), new Vector2(-15, 22));

            RectTransform footer = Panel("Footer", column, 70, 12, false);
            Button homeButton = Button("Home Button", footer, "Дом", font, hud.FocusHome);
            Button workshopButton = Button("Workshop Button", footer, "Мастерская", font, hud.OpenWorkshop);
            Button overviewButton = Button("Overview Button", footer, "Обзор", font, hud.ShowOverview);
            Row(homeButton, 0, 3, 10, 60);
            Row(workshopButton, 1, 3, 10, 60);
            Row(overviewButton, 2, 3, 10, 60);

            RectTransform toast = Panel("Message", column, 58, 94, false);
            Text message = Label("Message Text", toast, "Нажми на землю — Мохлик подойдёт.", font, 14, Cream, TextAnchor.MiddleCenter);
            Stretch(message.rectTransform, 12, 8);

            RectTransform details = Panel("Workshop Panel", column, 216, 94, false);
            Text detailsTitle = Label("Title", details, "Мастерская", font, 22, Cream, TextAnchor.MiddleLeft);
            TopLine(detailsTitle.rectTransform, 16, 12, 32, 65);
            Button closeWorkshop = Button("Close Button", details, "×", font, hud.ClosePanels);
            TopRight(closeWorkshop, 12, 12, 40);
            Text status = Label("Status", details, "Молоток стучит, работа идёт.", font, 15, Muted, TextAnchor.UpperLeft);
            TopLine(status.rectTransform, 16, 57, 26, 16);
            Button activity = Button("Activity Button", details, "Приостановить работу", font, hud.ToggleWorkshopActivity);
            Place((RectTransform)activity.transform, Vector2.zero, new Vector2(1, 0), new Vector2(14, 47), new Vector2(-14, 95));
            Text note = Label("Prototype Note", details, "Пробная работа · без ресурсов и сохранения", font, 12, Muted, TextAnchor.MiddleCenter);
            Place(note.rectTransform, Vector2.zero, new Vector2(1, 0), new Vector2(14, 9), new Vector2(-14, 37));

            RectTransform help = Panel("Help Panel", column, 316, 94, false);
            Text helpTitle = Label("Title", help, "Осмотрись в лесу", font, 21, Cream, TextAnchor.MiddleLeft);
            TopLine(helpTitle.rectTransform, 16, 12, 32, 65);
            Button closeHelp = Button("Close Button", help, "×", font, hud.ClosePanels);
            TopRight(closeHelp, 12, 12, 40);
            RectTransform helpViewport = Rect("Instructions Viewport", help);
            Place(helpViewport, Vector2.zero, Vector2.one, new Vector2(16, 108), new Vector2(-16, -60));
            helpViewport.gameObject.AddComponent<Image>().color = new Color(0, 0, 0, 0.001f);
            helpViewport.gameObject.AddComponent<RectMask2D>();
            Text instructions = Label("Instructions", helpViewport,
                "Нажми на свободную землю — Мохлик пойдёт туда.\n\nТяни карту для обзора. Своди пальцы или крути колесо, чтобы изменить масштаб.\n\nНажми на мастерскую, чтобы посмотреть её работу.",
                font, 15, Cream, TextAnchor.UpperLeft);
            instructions.rectTransform.anchorMin = new Vector2(0, 1);
            instructions.rectTransform.anchorMax = Vector2.one;
            instructions.rectTransform.pivot = new Vector2(0.5f, 1);
            instructions.rectTransform.sizeDelta = new Vector2(0, 150);
            instructions.rectTransform.anchoredPosition = Vector2.zero;
            ContentSizeFitter helpTextSize = instructions.gameObject.AddComponent<ContentSizeFitter>();
            helpTextSize.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
            ScrollRect helpScroll = helpViewport.gameObject.AddComponent<ScrollRect>();
            helpScroll.viewport = helpViewport;
            helpScroll.content = instructions.rectTransform;
            helpScroll.horizontal = false;
            helpScroll.vertical = true;
            helpScroll.movementType = ScrollRect.MovementType.Clamped;
            helpScroll.scrollSensitivity = 20;
            Button lighting = Button("Lighting Button", help, "Сделать вечер", font, hud.ToggleLighting);
            Button water = Button("Shore Button", help, "К воде", font, hud.FocusShore);
            water.interactable = shore != null;
            Row(lighting, 0, 2, 48, 94);
            Row(water, 1, 2, 48, 94);
            Text helpNote = Label("Prototype Note", help, "Планировка · без сохранения прогресса", font, 12, Muted, TextAnchor.MiddleCenter);
            Place(helpNote.rectTransform, Vector2.zero, new Vector2(1, 0), new Vector2(14, 10), new Vector2(-14, 39));

            safeArea.GetComponent<SafeAreaLayout>().Configure(column, new[] { details, help });

            hud.Configure(interaction, camera, home, workshop, shore,
                new[] { header, footer, toast, details, help }, help.gameObject, details.gameObject, toast.gameObject,
                message, status, activity.GetComponentInChildren<Text>(), lighting.GetComponentInChildren<Text>());
            help.gameObject.SetActive(false);
            details.gameObject.SetActive(false);
            toast.gameObject.SetActive(false);

            // A new layout scene has no existing event system. Reuse one if the caller supplied it.
            EventSystem eventSystem = UnityEngine.Object.FindFirstObjectByType<EventSystem>();
            if (eventSystem == null)
            {
                GameObject events = new GameObject("UI Event System", typeof(EventSystem), typeof(ForestPointerInputModule));
                eventSystem = events.GetComponent<EventSystem>();
                eventSystem.sendNavigationEvents = false;
            }
            return root;
        }

        private static RectTransform Rect(string name, Transform parent)
        {
            GameObject item = new GameObject(name, typeof(RectTransform));
            item.transform.SetParent(parent, false);
            return (RectTransform)item.transform;
        }

        private static RectTransform Panel(string name, Transform parent, float height, float inset, bool top)
        {
            RectTransform rect = Rect(name, parent);
            rect.anchorMin = new Vector2(0, top ? 1 : 0);
            rect.anchorMax = new Vector2(1, top ? 1 : 0);
            rect.pivot = new Vector2(0.5f, top ? 1 : 0);
            rect.sizeDelta = new Vector2(0, height);
            rect.anchoredPosition = new Vector2(0, top ? -inset : inset);
            Image image = rect.gameObject.AddComponent<Image>();
            image.color = PanelColor;
            Outline outline = rect.gameObject.AddComponent<Outline>();
            outline.effectColor = Edge;
            outline.effectDistance = new Vector2(1, -1);
            return rect;
        }

        private static Text Label(string name, Transform parent, string value, Font font, int size, Color color, TextAnchor anchor)
        {
            Text label = Rect(name, parent).gameObject.AddComponent<Text>();
            label.font = font;
            label.text = value;
            label.fontSize = size;
            label.color = color;
            label.alignment = anchor;
            label.horizontalOverflow = HorizontalWrapMode.Wrap;
            label.verticalOverflow = VerticalWrapMode.Truncate;
            label.raycastTarget = false;
            label.supportRichText = false;
            return label;
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
            colors.normalColor = ButtonColor;
            colors.highlightedColor = new Color(0.23f, 0.32f, 0.20f);
            colors.pressedColor = new Color(0.35f, 0.41f, 0.25f);
            colors.selectedColor = ButtonColor;
            colors.disabledColor = new Color(0.11f, 0.14f, 0.10f);
            colors.fadeDuration = 0.08f;
            button.colors = colors;
            Text label = Label("Label", rect, value, font, 15, Cream, TextAnchor.MiddleCenter);
            Stretch(label.rectTransform, 4, 4);
            UnityEventTools.AddPersistentListener(button.onClick, action);
            return button;
        }

        private static void Row(Button button, int index, int count, float bottom, float top)
        {
            Place((RectTransform)button.transform, new Vector2((float)index / count, 0), new Vector2((float)(index + 1) / count, 0),
                new Vector2(index == 0 ? 10 : 4, bottom), new Vector2(index == count - 1 ? -10 : -4, top));
        }

        private static void TopLine(RectTransform rect, float left, float top, float height, float right)
        {
            Place(rect, new Vector2(0, 1), new Vector2(1, 1), new Vector2(left, -top - height), new Vector2(-right, -top));
        }

        private static void TopRight(Button button, float right, float top, float size)
        {
            Place((RectTransform)button.transform, Vector2.one, Vector2.one,
                new Vector2(-right - size, -top - size), new Vector2(-right, -top));
        }

        private static void Stretch(RectTransform rect, float horizontal, float vertical)
        {
            Place(rect, Vector2.zero, Vector2.one, new Vector2(horizontal, vertical), new Vector2(-horizontal, -vertical));
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

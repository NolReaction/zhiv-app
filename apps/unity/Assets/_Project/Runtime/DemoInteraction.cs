using System;
using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>Small standalone presentation HUD; never writes player or economy data.</summary>
    [DisallowMultipleComponent]
    public sealed class DemoInteraction : MonoBehaviour
    {
        [SerializeField] private FixedWorldCamera worldCamera;
        [SerializeField] private WorldActorController actor;
        [SerializeField] private Transform workshop;
        [SerializeField] private Light sun;
        [SerializeField] private Transform activityTarget;
        [SerializeField] private bool workshopActive = true;

        public bool WorkshopActive => workshopActive;
        public bool WorkshopSelected => workshopSelected;
        public bool IsEvening => evening;
        public string Message => message;
        public event Action<bool> WorkshopActivityChanged;
        public event Action PresentationChanged;

        private Func<Vector2, bool> nativePointerBlocker;

        private bool workshopSelected;
        private bool evening;
        private bool subscribed;
        private Quaternion activityRestRotation;
        private Quaternion daylightRotation;
        private Color daylightColor;
        private float daylightIntensity;
        private Color daylightAmbient;
        private Color daylightSky;
        private Color daylightEquator;
        private Color daylightGround;
        private Color daylightFog;
        private string message = "Нажми на землю — Мохлик подойдёт.";
        private GUIStyle titleStyle;
        private GUIStyle textStyle;
        private GUIStyle buttonStyle;

        public void Configure(FixedWorldCamera camera, WorldActorController character, Transform building, Light sunlight)
        {
            Unsubscribe();
            worldCamera = camera;
            actor = character;
            workshop = building;
            sun = sunlight;
            if (Application.isPlaying && isActiveAndEnabled) Subscribe();
        }

        public void SetWorkshopActivityTarget(Transform target)
        {
            activityTarget = target;
            if (target != null) activityRestRotation = target.localRotation;
        }

        public void SetPointerBlocker(Func<Vector2, bool> blocker) => nativePointerBlocker = blocker;

        public void ClearPointerBlocker(Func<Vector2, bool> blocker)
        {
            if (nativePointerBlocker == blocker) nativePointerBlocker = null;
        }

        public void SelectWorkshop()
        {
            workshopSelected = true;
            SetMessage("Мастерская. Здесь можно запустить или остановить работу.");
        }

        public void ClearSelection()
        {
            workshopSelected = false;
            PresentationChanged?.Invoke();
        }

        public void ToggleWorkshopActivity()
        {
            workshopActive = !workshopActive;
            WorkshopActivityChanged?.Invoke(workshopActive);
            SetMessage(workshopActive ? "В мастерской снова стучит молоток." : "Мастерская отдыхает.");
        }

        private void SetMessage(string value)
        {
            message = value;
            PresentationChanged?.Invoke();
        }

        private void Awake()
        {
            if (sun != null)
            {
                daylightRotation = sun.transform.rotation;
                daylightColor = sun.color;
                daylightIntensity = sun.intensity;
            }
            daylightAmbient = RenderSettings.ambientLight;
            daylightSky = RenderSettings.ambientSkyColor;
            daylightEquator = RenderSettings.ambientEquatorColor;
            daylightGround = RenderSettings.ambientGroundColor;
            daylightFog = RenderSettings.fogColor;
            if (activityTarget != null) activityRestRotation = activityTarget.localRotation;
        }

        private void OnEnable() => Subscribe();
        private void OnDisable() => Unsubscribe();

        private void Subscribe()
        {
            if (subscribed || worldCamera == null) return;
            worldCamera.Tapped += OnTapped;
            worldCamera.IsPointerBlocked = PointerBlocked;
            subscribed = true;
        }

        private void Unsubscribe()
        {
            if (!subscribed || worldCamera == null) return;
            worldCamera.Tapped -= OnTapped;
            if (worldCamera.IsPointerBlocked == PointerBlocked) worldCamera.IsPointerBlocked = null;
            subscribed = false;
        }

        private void OnTapped(Ray ray)
        {
            // One combined raycast respects the nearest surface and never selects through trees.
            if (!Physics.Raycast(ray, out RaycastHit hit, 200, (1 << 8) | (1 << 9), QueryTriggerInteraction.Ignore))
                return;
            if (workshop != null && (hit.transform == workshop || hit.transform.IsChildOf(workshop)))
            {
                SelectWorkshop();
                return;
            }
            if (hit.collider.gameObject.layer != 8)
            {
                SetMessage("Здесь препятствие. Нажми на свободную землю рядом.");
                return;
            }
            workshopSelected = false;
            SetMessage(actor != null && actor.MoveTo(hit.point)
                ? "Идём! Здания и деревья нужно обходить."
                : "До этой точки пока нет свободного прохода.");
        }

        private void Update()
        {
            if (activityTarget == null) return;
            float swing = workshopActive ? Mathf.Sin(Time.time * 4.5f) * 28 : 0;
            activityTarget.localRotation = activityRestRotation * Quaternion.Euler(0, 0, swing);
        }

        private float UiScale => Mathf.Clamp(Mathf.Min(Screen.width / 430f, Screen.height / 760f), 1, 2.5f);

        private void Layout(out Rect header, out Rect footer)
        {
            float scale = UiScale;
            Rect safe = Screen.safeArea;
            float x = safe.x / scale;
            float y = (Screen.height - safe.yMax) / scale;
            float width = safe.width / scale;
            float height = safe.height / scale;
            float panelWidth = Mathf.Min(width - 24, 520);
            float panelX = x + (width - panelWidth) * 0.5f;
            header = new Rect(panelX, y + 12, panelWidth, 65);
            float footerHeight = workshopSelected ? 174 : 116;
            footer = new Rect(panelX, y + height - footerHeight - 12, panelWidth, footerHeight);
        }

        private bool PointerBlocked(Vector2 point)
        {
            if (nativePointerBlocker != null) return nativePointerBlocker(point);
            Layout(out Rect header, out Rect footer);
            Vector2 guiPoint = new Vector2(point.x, Screen.height - point.y) / UiScale;
            return header.Contains(guiPoint) || footer.Contains(guiPoint);
        }

        private void EnsureStyles()
        {
            if (titleStyle != null) return;
            titleStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 21, fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.96f, 0.92f, 0.75f) }
            };
            textStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 14, wordWrap = true,
                normal = { textColor = new Color(0.9f, 0.94f, 0.86f) }
            };
            buttonStyle = new GUIStyle(GUI.skin.button)
            {
                fontSize = 15, alignment = TextAnchor.MiddleCenter
            };
        }

        private void OnGUI()
        {
            if (nativePointerBlocker != null) return;
            EnsureStyles();
            Layout(out Rect header, out Rect footer);
            Matrix4x4 previousMatrix = GUI.matrix;
            Color previousColor = GUI.color;
            GUI.matrix = Matrix4x4.Scale(Vector3.one * UiScale);

            Panel(header);
            GUI.Label(new Rect(header.x + 14, header.y + 6, header.width - 28, 28), "Живой лес · 3D", titleStyle);
            GUI.Label(new Rect(header.x + 14, header.y + 34, header.width - 28, 25),
                "Тяни — обзор. Колесо / щипок — масштаб.", textStyle);

            Panel(footer);
            GUI.Label(new Rect(footer.x + 14, footer.y + 9, footer.width - 28, 42), message, textStyle);
            float buttonY = footer.y + 61;
            if (workshopSelected)
            {
                if (GUI.Button(new Rect(footer.x + 12, buttonY, footer.width - 24, 43),
                    workshopActive ? "Остановить работу мастерской" : "Запустить мастерскую", buttonStyle))
                {
                    ToggleWorkshopActivity();
                }
                buttonY += 58;
            }
            float halfWidth = (footer.width - 32) * 0.5f;
            if (GUI.Button(new Rect(footer.x + 12, buttonY, halfWidth, 43), evening ? "Сделать день" : "Сделать вечер", buttonStyle))
                ToggleLighting();
            if (GUI.Button(new Rect(footer.x + 20 + halfWidth, buttonY, halfWidth, 43), "Вернуть камеру", buttonStyle))
                worldCamera?.ResetView();

            GUI.matrix = previousMatrix;
            GUI.color = previousColor;
        }

        private static void Panel(Rect rect)
        {
            Color previous = GUI.color;
            GUI.color = new Color(0.055f, 0.115f, 0.09f, 0.94f);
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = previous;
        }

        public void ToggleLighting()
        {
            evening = !evening;
            if (sun != null)
            {
                sun.transform.rotation = evening ? Quaternion.Euler(18, -45, 0) : daylightRotation;
                sun.color = evening ? new Color(1, 0.64f, 0.36f) : daylightColor;
                sun.intensity = evening ? daylightIntensity * 0.55f : daylightIntensity;
            }
            RenderSettings.ambientLight = evening ? new Color(0.25f, 0.3f, 0.4f) : daylightAmbient;
            RenderSettings.ambientSkyColor = evening ? new Color(0.22f, 0.3f, 0.43f) : daylightSky;
            RenderSettings.ambientEquatorColor = evening ? new Color(0.12f, 0.2f, 0.25f) : daylightEquator;
            RenderSettings.ambientGroundColor = evening ? new Color(0.08f, 0.11f, 0.08f) : daylightGround;
            RenderSettings.fogColor = evening ? new Color(0.12f, 0.2f, 0.25f) : daylightFog;
            PresentationChanged?.Invoke();
        }
    }
}

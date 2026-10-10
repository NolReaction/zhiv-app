using UnityEngine;
using UnityEngine.UI;

namespace Zhiv.WorldPrototype.UI
{
    /// <summary>Presentation only. References point at ordinary editable scene UI objects.</summary>
    [DisallowMultipleComponent]
    public sealed class ForestHud : MonoBehaviour
    {
        [SerializeField] private DemoInteraction interaction;
        [SerializeField] private FixedWorldCamera worldCamera;
        [SerializeField] private Transform home;
        [SerializeField] private Transform workshop;
        [SerializeField] private Transform shore;
        [SerializeField] private RectTransform[] pointerPanels;
        [SerializeField] private GameObject helpPanel;
        [SerializeField] private GameObject workshopPanel;
        [SerializeField] private GameObject messagePanel;
        [SerializeField] private Text messageText;
        [SerializeField] private Text workshopStatus;
        [SerializeField] private Text activityButtonText;
        [SerializeField] private Text lightingButtonText;
        private bool subscribed;
        private string previousMessage;
        private float messageUntil;

        public void Configure(DemoInteraction demo, FixedWorldCamera camera, Transform homeTarget,
            Transform workshopTarget, Transform shoreTarget, RectTransform[] panels, GameObject help,
            GameObject workshopDetails, GameObject toast, Text toastText, Text status, Text activityLabel, Text lightingLabel)
        {
            Unsubscribe();
            interaction = demo;
            worldCamera = camera;
            home = homeTarget;
            workshop = workshopTarget;
            shore = shoreTarget;
            pointerPanels = panels;
            helpPanel = help;
            workshopPanel = workshopDetails;
            messagePanel = toast;
            messageText = toastText;
            workshopStatus = status;
            activityButtonText = activityLabel;
            lightingButtonText = lightingLabel;
            if (Application.isPlaying && isActiveAndEnabled) Subscribe();
        }

        private void OnEnable()
        {
            if (Application.isPlaying) Subscribe();
        }
        private void OnDisable() => Unsubscribe();

        private void Subscribe()
        {
            if (subscribed || interaction == null) return;
            interaction.PresentationChanged += Refresh;
            interaction.SetPointerBlocker(BlocksPointer);
            subscribed = true;
            Refresh();
        }

        private void Unsubscribe()
        {
            if (!subscribed || interaction == null) return;
            interaction.PresentationChanged -= Refresh;
            interaction.ClearPointerBlocker(BlocksPointer);
            subscribed = false;
        }

        private void Update()
        {
            if (messagePanel != null && messagePanel.activeSelf && Time.unscaledTime >= messageUntil)
                messagePanel.SetActive(false);
        }

        public bool BlocksPointer(Vector2 screenPoint)
        {
            // Camera input runs before EventSystem.Update. Check actual visible rectangles directly.
            if (!isActiveAndEnabled || pointerPanels == null) return false;
            foreach (RectTransform panel in pointerPanels)
                if (panel != null && panel.gameObject.activeInHierarchy
                    && RectTransformUtility.RectangleContainsScreenPoint(panel, screenPoint, null)) return true;
            return false;
        }

        private void Refresh()
        {
            if (interaction == null) return;
            bool selected = interaction.WorkshopSelected;
            if (selected && helpPanel != null) helpPanel.SetActive(false);
            if (workshopPanel != null) workshopPanel.SetActive(selected);
            if (workshopStatus != null) workshopStatus.text = interaction.WorkshopActive
                ? "Молоток стучит, работа идёт." : "Сейчас здесь тихо.";
            if (activityButtonText != null) activityButtonText.text = interaction.WorkshopActive
                ? "Приостановить работу" : "Продолжить работу";
            if (lightingButtonText != null) lightingButtonText.text = interaction.IsEvening ? "Сделать день" : "Сделать вечер";
            if (previousMessage != interaction.Message)
            {
                previousMessage = interaction.Message;
                if (messageText != null) messageText.text = previousMessage;
                messageUntil = Time.unscaledTime + 4;
                if (messagePanel != null) messagePanel.SetActive(!selected && (helpPanel == null || !helpPanel.activeSelf));
            }
        }

        public void FocusHome()
        {
            ClosePanels();
            if (home != null) worldCamera?.FocusOn(home.position);
        }

        public void OpenWorkshop()
        {
            if (helpPanel != null) helpPanel.SetActive(false);
            if (messagePanel != null) messagePanel.SetActive(false);
            if (workshop != null) worldCamera?.FocusOn(workshop.position);
            interaction?.SelectWorkshop();
        }

        public void ShowOverview()
        {
            ClosePanels();
            worldCamera?.ShowOverview();
        }

        public void FocusShore()
        {
            ClosePanels();
            if (shore != null) worldCamera?.FocusOn(shore.position);
        }

        public void ToggleHelp()
        {
            bool shouldOpen = helpPanel != null && !helpPanel.activeSelf;
            ClosePanels();
            if (helpPanel != null) helpPanel.SetActive(shouldOpen);
        }

        public void ClosePanels()
        {
            interaction?.ClearSelection();
            if (helpPanel != null) helpPanel.SetActive(false);
            if (workshopPanel != null) workshopPanel.SetActive(false);
            if (messagePanel != null) messagePanel.SetActive(false);
        }

        public void ToggleWorkshopActivity() => interaction?.ToggleWorkshopActivity();
        public void ToggleLighting() => interaction?.ToggleLighting();
    }
}

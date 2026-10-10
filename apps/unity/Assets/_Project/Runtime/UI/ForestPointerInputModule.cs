using UnityEngine.EventSystems;

namespace Zhiv.WorldPrototype.UI
{
    /// <summary>Mouse/touch UI input without requiring legacy Horizontal/Submit InputManager axes.</summary>
    public sealed class ForestPointerInputModule : StandaloneInputModule
    {
        public override bool ShouldActivateModule() => isActiveAndEnabled;

        public override void Process()
        {
            eventSystem.sendNavigationEvents = false;
            base.Process();
        }
    }
}

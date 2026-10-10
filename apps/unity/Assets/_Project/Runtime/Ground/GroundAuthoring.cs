using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>Links the editable recipe to its baked, manually sculptable Terrain.</summary>
    [DisallowMultipleComponent]
    public sealed class GroundAuthoring : MonoBehaviour
    {
        public Terrain Surface;
        public GroundRecipe Recipe;
    }
}

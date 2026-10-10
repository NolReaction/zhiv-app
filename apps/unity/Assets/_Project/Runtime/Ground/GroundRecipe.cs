using System;
using System.Collections.Generic;
using UnityEngine;

namespace Zhiv.WorldPrototype
{
    /// <summary>Editable world-space description; baking is an explicit Editor operation.</summary>
    [CreateAssetMenu(menuName = "Zhiv/Ground Recipe", fileName = "GroundRecipe")]
    public sealed class GroundRecipe : ScriptableObject
    {
        [Tooltip("Terrain lower southwest corner in world coordinates.")]
        public Vector3 Origin = new Vector3(-14f, -.8f, -17f);
        [Tooltip("World metres: X width, Y height range, Z length.")]
        public Vector3 Size = new Vector3(28f, 2f, 34f);
        public int Seed = 68;
        [Tooltip("World-space Y of the clearing before relief is applied.")]
        public float BaseHeight;
        [Min(0f)] public float Relief = .22f;
        [Min(0f)] public float PathDepression = .025f;
        public List<GroundTrail> Trails = new List<GroundTrail>();
        public List<GroundPad> Pads = new List<GroundPad>();
    }

    [Serializable]
    public sealed class GroundTrail
    {
        public string Name = "Trail";
        [Tooltip("Full width of the worn centre, in metres.")]
        [Min(.1f)] public float Width = 1.4f;
        [Tooltip("Additional grass-to-soil transition on each side, in metres.")]
        [Min(.05f)] public float Feather = .5f;
        [Tooltip("Ordered world-space X/Z control points. Two points form a straight path.")]
        public List<Vector2> Points = new List<Vector2>();
    }

    [Serializable]
    public sealed class GroundPad
    {
        public string Name = "Level pad";
        public Vector2 Center;
        [Tooltip("Full size of the level rectangle in world X/Z, in metres.")]
        public Vector2 Size = Vector2.one;
        [Tooltip("World-space Y under the object.")]
        public float Height;
        [Min(.05f)] public float Feather = .8f;
    }
}

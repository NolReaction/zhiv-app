using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    public sealed class ForestZoneDefinition
    {
        public readonly string Id;
        public readonly string DisplayName;
        public readonly Vector2 Center;
        public readonly Vector2 Entrance;
        public readonly Vector2 ClearingRadii;

        public ForestZoneDefinition(string id, string displayName, Vector2 center,
            Vector2 entrance, Vector2 clearingRadii)
        {
            Id = id;
            DisplayName = displayName;
            Center = center;
            Entrance = entrance;
            ClearingRadii = clearingRadii;
        }
    }

    /// <summary>A starting composition, copied into an editable asset exactly once.</summary>
    public static class ForestLayoutRecipe
    {
        public static readonly ForestZoneDefinition Home = new ForestZoneDefinition(
            "home", "Дом", new Vector2(0, 5), new Vector2(0, 2.5f), new Vector2(5.5f, 5f));
        public static readonly ForestZoneDefinition Workshop = new ForestZoneDefinition(
            "workshop", "Мастерская", new Vector2(-10, 10), new Vector2(-10, 7.4f), new Vector2(5f, 4.8f));
        public static readonly ForestZoneDefinition Ruins = new ForestZoneDefinition(
            "ruins", "Руины", new Vector2(-4, 19), new Vector2(-4, 16), new Vector2(4.8f, 4.8f));
        public static readonly ForestZoneDefinition Camp = new ForestZoneDefinition(
            "camp", "Костровая поляна", new Vector2(4, -5), new Vector2(4, -5), new Vector2(4.5f, 4.2f));
        public static readonly ForestZoneDefinition Market = new ForestZoneDefinition(
            "market", "Будущий рынок", new Vector2(-10, -17), new Vector2(-10, -14), new Vector2(5f, 4.5f));
        public static readonly ForestZoneDefinition Lookout = new ForestZoneDefinition(
            "lookout", "Мыс", new Vector2(13, -22), new Vector2(13, -22), new Vector2(3.8f, 3.8f));
        public static readonly ForestZoneDefinition Shore = new ForestZoneDefinition(
            "shore", "Берег", new Vector2(5, -10), new Vector2(5, -10), new Vector2(2.3f, 2.8f));

        private static readonly ForestZoneDefinition[] ZoneValues =
            { Home, Workshop, Ruins, Camp, Market, Lookout, Shore };
        public static IReadOnlyList<ForestZoneDefinition> Zones => ZoneValues;
        public static readonly Vector2 LakeCenter = new Vector2(12, -11);
        public static readonly Vector2 LakeRadii = new Vector2(6, 8);
        public const float WaterHeight = -.25f;

        public static GroundRecipe Create(string assetFolder)
        {
            if (string.IsNullOrWhiteSpace(assetFolder) || !AssetDatabase.IsValidFolder(assetFolder))
                throw new ArgumentException("Create an Assets folder for the forest recipe first.", nameof(assetFolder));
            var recipe = ScriptableObject.CreateInstance<GroundRecipe>();
            recipe.name = "Forest Layout Ground";
            recipe.Origin = new Vector3(-24, -1.8f, -28);
            recipe.Size = new Vector3(48, 4, 56);
            recipe.Seed = 6810;
            recipe.BaseHeight = 0;
            recipe.Relief = .22f;
            recipe.PathDepression = .025f;

            AddTrail(recipe, "Home to workshop", 1.55f, Home.Entrance,
                new Vector2(-3, 2), new Vector2(-6, 4.5f), Workshop.Entrance);
            AddTrail(recipe, "Workshop to ruins", 1.35f, Workshop.Entrance,
                new Vector2(-12.7f, 6.6f), new Vector2(-14, 10),
                new Vector2(-12, 14), new Vector2(-8, 16), Ruins.Entrance);
            AddTrail(recipe, "Home to camp", 1.55f, Home.Entrance,
                new Vector2(1.8f, 0), new Vector2(2.5f, -2.5f), Camp.Entrance);
            AddTrail(recipe, "Camp to market", 1.5f, Camp.Entrance,
                new Vector2(0, -8), new Vector2(-4.5f, -10.5f), Market.Entrance);
            AddTrail(recipe, "Camp to shore", 1.2f, Camp.Entrance,
                new Vector2(3.9f, -7.6f), Shore.Entrance);
            AddTrail(recipe, "Market to lookout", 1.4f, Market.Entrance,
                new Vector2(-5.5f, -16), new Vector2(-1, -19.5f), new Vector2(5, -22), Lookout.Entrance);

            // Building foundations are independent of the gentle surrounding relief.
            AddPad(recipe, "Home foundation", Home.Center, new Vector2(4.2f, 4.4f), 0, 1.2f);
            AddPad(recipe, "Workshop foundation", Workshop.Center, new Vector2(4.4f, 4.6f), 0, 1.2f);
            AddPad(recipe, "Ruins footprint", Ruins.Center, new Vector2(5.2f, 4.8f), 0, 1.2f);
            AddPad(recipe, "Camp gathering place", Camp.Center, new Vector2(4.8f, 4.4f), 0, 1.4f);
            AddPad(recipe, "Market footprint", Market.Center, new Vector2(5.8f, 4.6f), 0, 1.2f);
            AddPad(recipe, "Lookout footprint", Lookout.Center, new Vector2(4.5f, 4.4f), 0, 1.2f);
            // An inscribed rectangle plus a broad feather produces rounded banks. Water is then
            // fitted to the baked height contour, rather than put on top of a flat ground plane.
            AddPad(recipe, "Lake basin", LakeCenter, new Vector2(6, 8), -.8f, 3f);

            GroundPathMath.ValidateRecipe(recipe);
            string path = AssetDatabase.GenerateUniqueAssetPath(assetFolder + "/ForestGroundRecipe.asset");
            AssetDatabase.CreateAsset(recipe, path);
            AssetDatabase.SaveAssets();
            GroundRecipe saved = AssetDatabase.LoadAssetAtPath<GroundRecipe>(path);
            if (saved == null)
                throw new InvalidOperationException("Не удалось загрузить сохранённый рецепт леса: " + path);
            GroundPathMath.ValidateRecipe(saved);
            return saved;
        }

        public static bool InLakeReserve(Vector2 point, float margin = 0)
        {
            Vector2 d = point - LakeCenter;
            float x = d.x / (LakeRadii.x + margin);
            float z = d.y / (LakeRadii.y + margin);
            return x * x + z * z <= 1f;
        }

        public static bool InClearing(Vector2 point, float margin = 0)
        {
            foreach (ForestZoneDefinition zone in ZoneValues)
            {
                Vector2 d = point - zone.Center;
                float x = d.x / (zone.ClearingRadii.x + margin);
                float z = d.y / (zone.ClearingRadii.y + margin);
                if (x * x + z * z < 1f) return true;
            }
            return false;
        }

        private static void AddTrail(GroundRecipe recipe, string name, float width, params Vector2[] points)
        {
            recipe.Trails.Add(new GroundTrail
            {
                Name = name, Width = width, Feather = .65f, Points = new List<Vector2>(points)
            });
        }

        private static void AddPad(GroundRecipe recipe, string name, Vector2 center, Vector2 size,
            float height, float feather)
        {
            recipe.Pads.Add(new GroundPad
            {
                Name = name, Center = center, Size = size, Height = height, Feather = feather
            });
        }
    }
}

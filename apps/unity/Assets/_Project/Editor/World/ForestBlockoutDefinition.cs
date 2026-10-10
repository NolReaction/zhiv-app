using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>
    /// Composition before decoration: authored woodland silhouettes and a connected path network.
    /// The old Tiled geography supplies the landmarks; nothing is generated on import or Play.
    /// </summary>
    public static class ForestBlockoutDefinition
    {
        public static readonly ExpandedForestZone Home = Zone("home", "01 · Дом Мохлика", 6, 0, 11);
        public static readonly ExpandedForestZone Workshop = Zone("workshop", "02 · Мастерская", -42, 10, 10);
        public static readonly ExpandedForestZone Garden = Zone("garden", "03 · Ягодный куст", -10, 3, 5, 4);
        public static readonly ExpandedForestZone Quarry = Zone("quarry", "04 · Шахта", 0, 46, 10);
        public static readonly ExpandedForestZone Woodlot = Zone("woodlot", "05 · Лесной участок", 33, 48, 10);
        public static readonly ExpandedForestZone Shop = Zone("shop", "06 · Лавка Плёски", 43, 14, 10);
        public static readonly ExpandedForestZone Camp = Zone("camp", "07 · Костёр", 8, -13, 5, 4);
        public static readonly ExpandedForestZone Warehouse = Zone("warehouse", "08 · Кладовая", -10, -17, 7, 6);
        public static readonly ExpandedForestZone BuilderHome = Zone("builder-home", "09 · Дом Шишколапа", 20, -37, 9);
        public static readonly ExpandedForestZone Market = Zone("market", "10 · Место рынка", -30, -56, 9, 8, true);
        public static readonly ExpandedForestZone Fishing = Zone("fishing", "11 · Рыбацкий берег", 50, -7, 8);
        public static readonly ExpandedForestZone Lighthouse = Zone("lighthouse", "12 · Маяк", 46, -59, 9);
        public static readonly ExpandedForestZone UpperPass = Zone("upper-pass", "13 · Северо-западная поляна", -46, 50, 10, 8, true);
        private static readonly ExpandedForestZone[] ZoneValues = {
            Home, Workshop, Garden, Quarry, Woodlot, Shop, Camp, Warehouse,
            BuilderHome, Market, Fishing, Lighthouse, UpperPass
        };
        public static IReadOnlyList<ExpandedForestZone> Zones => ZoneValues;

        public static GroundRecipe Create(string assetFolder)
        {
            if (string.IsNullOrWhiteSpace(assetFolder) || !AssetDatabase.IsValidFolder(assetFolder))
                throw new ArgumentException("Create an Assets folder for the blockout recipe first.", nameof(assetFolder));
            GroundRecipe recipe = CreateTransient();
            string path = AssetDatabase.GenerateUniqueAssetPath(assetFolder + "/ForestBlockoutRecipe.asset");
            AssetDatabase.CreateAsset(recipe, path);
            AssetDatabase.SaveAssets();
            GroundRecipe saved = AssetDatabase.LoadAssetAtPath<GroundRecipe>(path);
            if (saved == null) throw new InvalidOperationException("Не удалось загрузить сохранённый рецепт планировки: " + path);
            GroundPathMath.ValidateRecipe(saved);
            return saved;
        }

        public static GroundRecipe CreateTransient()
        {
            // Keep the established continuous coast and physical camera buffer. Replace only
            // the circles-and-scatter composition; old recipes and scenes remain untouched.
            GroundRecipe recipe = ExpandedForestDefinition.CreateTransient();
            recipe.name = "Forest Contour Blockout";
            recipe.Seed = 681020;
            recipe.Relief = .12f;
            recipe.Trails.Clear();
            recipe.Pads.Clear();

            Trail(recipe, "Дом — мастерская", 3.2f, Home, Workshop,
                P(-4, -8), P(-19, -12), P(-35, -9), P(-43, -2));
            Trail(recipe, "Мастерская — северо-западная поляна", 2.6f, Workshop, UpperPass,
                P(-49, 16), P(-53, 28), P(-50, 38));
            Trail(recipe, "Мастерская — шахта", 3f, Workshop, Quarry,
                P(-32, 21), P(-26, 26), P(-18, 35), P(-8, 37));
            Trail(recipe, "Шахта — лесной участок", 2.8f, Quarry, Woodlot,
                P(12, 45), P(19, 51), P(27, 53), P(35, 49));
            Trail(recipe, "Лесной участок — лавка", 2.8f, Woodlot, Shop,
                P(43, 37), P(52, 31), P(55, 23), P(52, 16));
            Trail(recipe, "Лавка — рыбацкий берег", 2.5f, Shop, Fishing,
                P(48, 3), P(45, -3), P(46, -10), P(51, -14), P(55, -13));
            Trail(recipe, "Дом — лавка", 3.2f, Home, Shop,
                P(18, 4), P(30, 6), P(38, 3), P(44, 4));
            Trail(recipe, "Дом — ягодный куст", 2f, Home, Garden,
                P(3, -6), P(-3, -3));
            Trail(recipe, "Дом — костёр", 2.4f, Home, Camp,
                P(15, -8), P(16, -14));
            Trail(recipe, "Дом — кладовая", 2.6f, Home, Warehouse,
                P(1, -9), P(-5, -12), P(-5, -17));
            Trail(recipe, "Кладовая — место рынка", 2.8f, Warehouse, Market,
                P(-17, -23), P(-27, -31), P(-35, -40), P(-39, -50), P(-33, -60));
            Trail(recipe, "Костёр — дом Шишколапа", 2.8f, Camp, BuilderHome,
                P(13, -21), P(17, -27), P(15, -34), P(16, -42), P(22, -44));
            Trail(recipe, "Дом Шишколапа — маяк", 2.6f, BuilderHome, Lighthouse,
                P(20, -47), P(27, -54), P(33, -61), P(38, -67), P(47, -68));

            foreach (ExpandedForestZone zone in ZoneValues)
                recipe.Pads.Add(new GroundPad { Name = zone.DisplayName + " · основание", Center = zone.Center,
                    Size = zone.Footprint, Height = 0, Feather = zone.Footprint.x <= 4 ? 1.5f : 2.2f });

            // Each outline is a deliberate mass, not a grid with circular holes. The negative
            // space between these polygons is the connected system of clearings and paths.
            Forest(recipe, "Западная опушка", P(-86, -90), P(-80, 94), P(-68, 89), P(-64, 70),
                P(-60, 48), P(-61, 25), P(-57, 10), P(-58, -9), P(-53, -26), P(-59, -47), P(-67, -69), P(-75, -86));
            Forest(recipe, "Северный дальний лес", P(-74, 87), P(-30, 90), P(14, 82), P(63, 79),
                P(78, 73), P(70, 60), P(55, 57), P(44, 62), P(30, 65), P(18, 63), P(9, 59), P(-4, 63), P(-19, 61), P(-29, 67), P(-45, 66), P(-61, 70));
            Forest(recipe, "Разделитель северных полян", P(-45, 32), P(-31, 37), P(-22, 44),
                P(-18, 57), P(-28, 60), P(-36, 59), P(-37, 51), P(-36, 40));
            Forest(recipe, "Лес между мастерской и домом", P(-30, -2), P(-23, -4), P(-18, 0),
                P(-20, 9), P(-25, 17), P(-29, 17), P(-29, 9), P(-32, 4));
            Forest(recipe, "Северная кромка домашней поляны", P(-15, 11), P(-2, 13), P(8, 22),
                P(11, 34), P(5, 36), P(-4, 30), P(-13, 29), P(-18, 20));
            Forest(recipe, "Лес под северо-восточной поляной", P(17, 21), P(25, 24), P(30, 34),
                P(27, 41), P(19, 43), P(14, 39), P(15, 29));
            Forest(recipe, "Восточная опушка", P(60, 58), P(86, 70), P(102, 45), P(94, 22),
                P(78, 11), P(65, 20), P(62, 31), P(65, 42));
            Forest(recipe, "Восточный разделитель у берега", P(23, -3), P(34, -1), P(42, -4),
                P(42, -12), P(36, -22), P(26, -24), P(18, -19), P(21, -11));
            Forest(recipe, "Юго-западный лес", P(-59, -18), P(-48, -18), P(-37, -22),
                P(-32, -31), P(-38, -36), P(-46, -35), P(-56, -43), P(-64, -30));
            Forest(recipe, "Лес перед речным рукавом", P(-18, -38), P(-9, -35), P(-6, -41),
                P(-9, -50), P(-12, -61), P(-19, -65), P(-23, -57), P(-21, -48));

            GroundPathMath.ValidateRecipe(recipe);
            return recipe;
        }

        private static ExpandedForestZone Zone(string id, string name, float u, float v,
            float radius, float size = 8, bool future = false) =>
            new ExpandedForestZone(id, name, P(u, v), radius, future, new Vector2(size, size));

        private static Vector2 P(float u, float v) => new Vector2(u, v);

        private static void Forest(GroundRecipe recipe, string name, params Vector2[] mapPoints)
        {
            var region = new GroundForestRegion { Name = name, Feather = 1.5f };
            foreach (Vector2 point in mapPoints) region.Points.Add(ExpandedForestDefinition.ToWorldXZ(point));
            recipe.ForestRegions.Add(region);
        }

        private static void Trail(GroundRecipe recipe, string name, float width,
            ExpandedForestZone from, ExpandedForestZone to, params Vector2[] mapPoints)
        {
            var points = new List<Vector2> { from.Entrance, from.Entrance + new Vector2(0, -2) };
            foreach (Vector2 point in mapPoints) points.Add(ExpandedForestDefinition.ToWorldXZ(point));
            points.Add(to.Entrance + new Vector2(0, -2));
            points.Add(to.Entrance);
            recipe.Trails.Add(new GroundTrail { Name = name, Width = width, Feather = 1.1f, Points = points });
        }
    }
}

import { prepareVectorBuilding } from "./lib/prepare-vector-building.mjs";

await prepareVectorBuilding("workshop", "forest-workshop-vector", { check: process.argv.includes("--check") });

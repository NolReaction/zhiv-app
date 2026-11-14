import { prepareVectorBuilding } from "./lib/prepare-vector-building.mjs";

await prepareVectorBuilding("home", "home-vector", { check: process.argv.includes("--check") });

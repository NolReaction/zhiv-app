"use client";

import { useState } from "react";
import { EarthMap } from "../earth-map";
import { createEarthCameraSession } from "../camera-session";
import { getEarthModelPlacements } from "../model-placement";

/** A local workshop with the real map/renderer, independent of login and GPS. */
export function EarthModelPreview() {
  const [infoOpen, setInfoOpen] = useState(false);
  const [camera] = useState(() => {
    const controller = createEarthCameraSession("earth-model-preview");
    controller.activate();
    const placement = getEarthModelPlacements()[0];
    controller.session.save({ center: [placement.longitude, placement.latitude], zoom: 15.7, pitch: 55, bearing: 0 });
    controller.session.savePreferences({ weatherEnabled: false, lightingMode: "day", buildings3d: true, eveningCenter: null });
    return controller.session;
  });
  return <main style={{ width: "100%", height: "100dvh", position: "relative", overflow: "hidden" }} aria-label="Мастерская 3D-моделей Земли">
    <EarthMap position={null} active visible cameraSession={camera} focusRequest={0} isOnline
      onLocate={() => {}} locating={false} locationActive={false} locationDetails={null} showLocationControl={false}
      infoOpen={infoOpen} onInfoOpenChange={setInfoOpen} />
  </main>;
}

export type GaragePoint = { x: number; y: number };
export type GarageMatrix = [number, number, number, number, number, number];
export type GarageCamera = GaragePoint & { width: number };
export type GarageViewportMode = "portrait" | "landscape";
export type GarageCameraMode = GarageViewportMode;

export type GarageAsset = {
  id: string;
  name: string;
  src: string;
  width: number;
  height: number;
};

export type GarageSocket = GaragePoint & { id: string; name: string };

/** x/y place the normalized pivot in the parent's image coordinates.
 * With a socket, x/y become offsets from that socket. Dimensions precede scale. */
export type GarageNode = {
  id: string;
  name: string;
  assetId: string | null;
  parentId: string | null;
  socketId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
  zIndex: number;
  visible: boolean;
  locked: boolean;
  sockets: GarageSocket[];
};

export type GarageScene = {
  schemaVersion: 1;
  canvas: { width: number; height: number };
  cameras: Record<GarageViewportMode, GarageCamera>;
  assets: GarageAsset[];
  nodes: GarageNode[];
};

export const SKINS = {
  wood: {
    label: "原木", stage: "#101418", panel: "#171512", table: "#6b5636",
    board: "#d99f52", edge: "#7a4a22", grid: "#3a2410",
    dark: "#14151a", light: "#f4f0e4", accent: "#efb96f", glow: "#ffd166",
  },
  celadon: {
    label: "青瓷", stage: "#132a28", panel: "#112521", table: "#21413a",
    board: "#82b9a0", edge: "#396c5c", grid: "#244a40",
    dark: "#122a28", light: "#fff3d9", accent: "#a5dcc1", glow: "#e7f6a9",
  },
  midnight: {
    label: "星夜", stage: "#141b35", panel: "#151a34", table: "#192644",
    board: "#414f7f", edge: "#26345e", grid: "#bdcaf1",
    dark: "#101225", light: "#f7edff", accent: "#c2ccff", glow: "#f3aefa",
  },
} as const;

export type Skin = keyof typeof SKINS;
export const SKIN_IDS = ["wood", "celadon", "midnight"] as const satisfies readonly Skin[];

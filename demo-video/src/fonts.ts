import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";

// Loaded for the side effect only — the scenes reference the families by name
// ("Inter" / "JetBrains Mono") inline so every style stays editable in Studio.
loadInter("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
loadJetBrainsMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

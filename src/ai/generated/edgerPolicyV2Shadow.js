// Shadow-only bootstrap. A campaign export replaces this with generated
// float32 actor weights; src/ai/generated/edgerPolicyCurrent.js remains live.
import { createEdgerV2BootstrapModel } from "../v2/policy.js";

export const EDGER_POLICY_V2_SHADOW_MODEL = createEdgerV2BootstrapModel();

export default EDGER_POLICY_V2_SHADOW_MODEL;

import {
  assessStrictSelectionRequirements,
  productMeetsSupportedStrictAutoStartRequirement,
  productMeetsSupportedStrictMaterialRequirement
} from '../../../../src/ai/agentManagerCardSelection.ts';
import {
  extractConfirmedGeneratorNominalPowerKw,
  generatorPhaseProfile,
  productMatchesIntent,
  productPowerSource
} from '../../../../src/ai/productClassifier.ts';
import { AgentIntentContractSchema, ToolResultSchema } from '../../../../src/ai/agentManagerContracts.ts';

const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
if (!token) throw new Error('ADMIN_PASSWORD or ADMIN_API_KEY is required');

const sessionId = '18a8f799-8325-43d2-a236-c2e0531078a2';
const response = await fetch(`https://chat-ai-production-3057.up.railway.app/api/admin/conversations/${sessionId}`, {
  headers: { Authorization: `Bearer ${token}` }
});
if (!response.ok) throw new Error(`Admin detail failed: ${response.status}`);
const detail = await response.json() as {
  messages: Array<{ role: string; createdAt: string; metadata?: Record<string, unknown> }>;
};
const assistantMessages = detail.messages
  .filter((message) => message.role === 'assistant')
  .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
const first = assistantMessages[0]?.metadata as {
  cardSelection?: { products?: unknown[] };
} | undefined;
const second = assistantMessages[1]?.metadata as {
  intentContract?: unknown;
  toolResults?: unknown[];
  cardSelection?: { products?: unknown[] };
} | undefined;
if (!first || !second) throw new Error('Expected two assistant messages');

const intent = AgentIntentContractSchema.parse(second.intentContract);
const toolResults = (second.toolResults ?? []).map((result) => ToolResultSchema.parse(result));
const products = [
  ...(first.cardSelection?.products ?? []),
  ...(second.cardSelection?.products ?? [])
] as Array<any>;
const assessment = assessStrictSelectionRequirements(intent, 'generator', toolResults);

console.log(JSON.stringify({
  strictAssessment: assessment,
  products: products.map((product) => ({
    id: product.id,
    name: product.name,
    price: product.price,
    classMatch: productMatchesIntent(product, 'generator'),
    phase: generatorPhaseProfile(product),
    nominalKw: extractConfirmedGeneratorNominalPowerKw(product),
    powerSource: productPowerSource(product),
    autostartMatch: productMeetsSupportedStrictAutoStartRequirement(product, intent, 'generator'),
    materialMatch: productMeetsSupportedStrictMaterialRequirement(product, intent, 'generator')
  }))
}, null, 2));

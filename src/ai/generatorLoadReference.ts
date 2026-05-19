import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProductElectricalLoadItem } from '../shared/types.js';

export type GeneratorLoadClass =
  | 'resistive_light_load'
  | 'small_electronics_load'
  | 'motor_compressor_load'
  | 'handheld_tool_load'
  | 'heating_resistive_load'
  | 'workshop_industrial_load'
  | 'unknown_named_load';

export type GeneratorLoadConfidence = 'high' | 'medium' | 'low';

export interface GeneratorReferenceEntry {
  id: string;
  loadClass: GeneratorLoadClass;
  consumers: string[];
  importantParameters: string[];
  howToDeterminePower: string;
  runningKwTypical?: [number, number];
  conservativeRunningKw?: number;
  startingFactorTypical?: [number, number];
  conservativeStartingKw?: number;
  confidence: GeneratorLoadConfidence;
  canEstimate: boolean;
  preliminaryQuestion: string;
  sourceNote: string;
  aliases: RegExp[];
  runtime?: boolean;
}

export interface PersistedGeneratorReferenceEntry {
  id: string;
  loadClass: GeneratorLoadClass;
  consumers: string[];
  aliases: string[];
  importantParameters: string[];
  howToDeterminePower: string;
  runningKwTypical?: [number, number];
  conservativeRunningKw?: number;
  startingFactorTypical?: [number, number];
  conservativeStartingKw?: number;
  confidence: GeneratorLoadConfidence;
  canEstimate: boolean;
  preliminaryQuestion: string;
  sourceNote: string;
  updatedAt?: string;
}

export type GeneratorLoadMentionRole = 'active' | 'staged' | 'excluded' | 'context';

export interface GeneratorLoadDetection {
  reference: GeneratorReferenceEntry;
  evidence: string;
  role: GeneratorLoadMentionRole;
  roleEvidence?: string;
}

const sourceNote = 'Curated baseline from generator sizing/wattage charts: Generator Source, Fubag starting-current table, Elec.ru generator FAQ, PowerToolLab power-tool chart. Verify exact value by nameplate/manual when available.';
const webAverageSourcePrefix = 'web_average:';

function generatorReferenceOverlayPath() {
  return process.env.GENERATOR_LOAD_REFERENCE_PATH ||
    join(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd(), 'data', 'generator-load-reference-overrides.json');
}

function normalizeId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-zа-я0-9]+/giu, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'consumer';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim();
}

function normalizeRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const first = Number(value[0]);
  const second = Number(value[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second) || first < 0 || second < first) return undefined;
  return [Math.round(first * 100) / 100, Math.round(second * 100) / 100];
}

function isLoadClass(value: unknown): value is GeneratorLoadClass {
  return typeof value === 'string' && [
    'resistive_light_load',
    'small_electronics_load',
    'motor_compressor_load',
    'handheld_tool_load',
    'heating_resistive_load',
    'workshop_industrial_load',
    'unknown_named_load'
  ].includes(value);
}

function isConfidence(value: unknown): value is GeneratorLoadConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

function asStringArray(value: unknown, limit = 16) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit);
}

function sanitizePersistedEntry(raw: unknown): PersistedGeneratorReferenceEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!isLoadClass(value.loadClass) || !isConfidence(value.confidence)) return null;
  const consumers = asStringArray(value.consumers, 8);
  const aliases = asStringArray(value.aliases, 24);
  const importantParameters = asStringArray(value.importantParameters, 10);
  const conservativeRunningKw = Number(value.conservativeRunningKw);
  const conservativeStartingKw = Number(value.conservativeStartingKw);
  const id = normalizeId(String(value.id || consumers[0] || aliases[0] || 'consumer'));
  const source = String(value.sourceNote || '').trim();
  if (!consumers.length || !aliases.length || !importantParameters.length) return null;
  if (value.canEstimate !== false && (!Number.isFinite(conservativeRunningKw) || conservativeRunningKw <= 0)) return null;
  return {
    id: id.startsWith('runtime_') ? id : `runtime_${id}`,
    loadClass: value.loadClass,
    consumers,
    aliases: Array.from(new Set([...aliases, ...consumers])).slice(0, 32),
    importantParameters,
    howToDeterminePower: String(value.howToDeterminePower || 'По модели/шильдику; веб-ориентир использовать только предварительно.').trim(),
    runningKwTypical: normalizeRange(value.runningKwTypical),
    conservativeRunningKw: Number.isFinite(conservativeRunningKw) && conservativeRunningKw > 0 ? Math.round(conservativeRunningKw * 100) / 100 : undefined,
    startingFactorTypical: normalizeRange(value.startingFactorTypical),
    conservativeStartingKw: Number.isFinite(conservativeStartingKw) && conservativeStartingKw > 0 ? Math.round(conservativeStartingKw * 100) / 100 : undefined,
    confidence: value.confidence,
    canEstimate: value.canEstimate !== false,
    preliminaryQuestion: String(value.preliminaryQuestion || 'Какая модель/паспортная мощность этого потребителя?').trim(),
    sourceNote: source.startsWith(webAverageSourcePrefix) ? source : `${webAverageSourcePrefix} ${source || 'LLM web search summary; verify by model/nameplate before final selection.'}`,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
  };
}

export function loadPersistedGeneratorReferenceEntries(): PersistedGeneratorReferenceEntry[] {
  const filePath = generatorReferenceOverlayPath();
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const entries = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { entries?: unknown[] })?.entries) ? (parsed as { entries: unknown[] }).entries : [];
    return entries.map(sanitizePersistedEntry).filter((entry): entry is PersistedGeneratorReferenceEntry => Boolean(entry));
  } catch (error) {
    console.warn('Generator load reference overlay read failed', error instanceof Error ? error.message : String(error));
    return [];
  }
}

export function upsertGeneratorLoadReferenceEntry(entry: PersistedGeneratorReferenceEntry): PersistedGeneratorReferenceEntry {
  const sanitized = sanitizePersistedEntry(entry);
  if (!sanitized) throw new Error('Invalid generator load reference entry');
  const filePath = generatorReferenceOverlayPath();
  const entries = loadPersistedGeneratorReferenceEntries();
  const next = entries.filter((existing) => existing.id !== sanitized.id);
  next.push({ ...sanitized, updatedAt: new Date().toISOString() });
  next.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ entries: next }, null, 2)}\n`, 'utf8');
  return next.find((item) => item.id === sanitized.id)!;
}

function runtimeEntryToReference(entry: PersistedGeneratorReferenceEntry): GeneratorReferenceEntry {
  return {
    ...entry,
    aliases: entry.aliases.map((alias) => new RegExp(escapeRegExp(normalizeText(alias)), 'iu')),
    runtime: true
  };
}

function allGeneratorReferenceEntries(): GeneratorReferenceEntry[] {
  return [...generatorReferenceTable, ...loadPersistedGeneratorReferenceEntries().map(runtimeEntryToReference)];
}

export function shouldEnrichGeneratorLoadReference(text: string): boolean {
  const normalized = normalizeText(text);
  if (!/(генератор|электростанц|резервн[а-я ]+питан|питан[а-я ]+для)/iu.test(text)) return false;
  if (generatorReferenceLoadItemsFromText(text).length) return false;
  const detections = classifyGeneratorLoadText(text);
  if (detections.some((item) => item.reference.runtime)) return false;
  if (detections.some((item) => item.reference.loadClass === 'unknown_named_load')) return true;
  return /(?:для|питать|запитать|подключить|работал[аио]?|тянуть)\s+([a-zа-я0-9 -]{3,60})/iu.test(normalized);
}

export const generatorReferenceTable: GeneratorReferenceEntry[] = [
  {
    id: 'lighting_led',
    loadClass: 'resistive_light_load',
    consumers: ['свет', 'LED-лампы', 'освещение', 'прожектор'],
    importantParameters: ['количество ламп', 'суммарная мощность Вт', 'тип ламп'],
    howToDeterminePower: 'Сложить мощность всех одновременно включенных ламп; если неизвестно — брать бытовой резерв 0,5 кВт.',
    runningKwTypical: [0.1, 0.5],
    conservativeRunningKw: 0.5,
    startingFactorTypical: [1, 1],
    conservativeStartingKw: 0.5,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Сколько примерно ламп/прожекторов будет включено одновременно?',
    sourceNote,
    aliases: [/свет/iu, /освещен/iu, /ламп/iu, /прожектор/iu, /\blight(?:ing)?\b/iu]
  },
  {
    id: 'small_electronics',
    loadClass: 'small_electronics_load',
    consumers: ['роутер', 'зарядки', 'камеры', 'ноутбук', 'сигнализация'],
    importantParameters: ['количество устройств', 'чувствительность к качеству напряжения', 'наличие ИБП'],
    howToDeterminePower: 'Сложить паспортные мощности блоков питания; если неизвестно — 0,3 кВт как бытовой резерв.',
    runningKwTypical: [0.05, 0.3],
    conservativeRunningKw: 0.3,
    startingFactorTypical: [1, 1],
    conservativeStartingKw: 0.3,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Есть ли чувствительная электроника, для которой нужен инвертор/стабильное напряжение?',
    sourceNote,
    aliases: [/роутер/iu, /зарядк/iu, /камер/iu, /ноутбук/iu, /сигнализац/iu, /телеком/iu]
  },
  {
    id: 'tv_hifi',
    loadClass: 'small_electronics_load',
    consumers: ['телевизор', 'приставка', 'аудио/Hi-Fi'],
    importantParameters: ['диагональ/модель', 'одновременно включённые устройства'],
    howToDeterminePower: 'По паспорту ТВ/БП; без паспорта использовать 0,5 кВт как верхний бытовой ориентир.',
    runningKwTypical: [0.1, 0.5],
    conservativeRunningKw: 0.5,
    startingFactorTypical: [1, 1],
    conservativeStartingKw: 0.5,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Будет только ТВ/роутер или ещё холодильник/насос/инструмент?',
    sourceNote,
    aliases: [/телевиз/iu, /\btv\b/iu, /hi[- ]?fi/iu, /приставк/iu]
  },
  {
    id: 'refrigerator',
    loadClass: 'motor_compressor_load',
    consumers: ['холодильник'],
    importantParameters: ['количество', 'старый/новый компрессор', 'одновременный запуск с насосом'],
    howToDeterminePower: 'По шильдику; если неизвестно — рабочая 0,2–0,6 кВт, пуск до 1–2 кВт.',
    runningKwTypical: [0.2, 0.6],
    conservativeRunningKw: 0.6,
    startingFactorTypical: [3, 4],
    conservativeStartingKw: 2,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Холодильник один или несколько, и есть ли ещё насос/компрессор?',
    sourceNote,
    aliases: [/холодильник/iu, /fridge/iu, /refrigerator/iu]
  },
  {
    id: 'freezer',
    loadClass: 'motor_compressor_load',
    consumers: ['морозильник', 'морозильный ларь'],
    importantParameters: ['количество', 'объём', 'старый/новый компрессор'],
    howToDeterminePower: 'По шильдику; без него считать как компрессорную нагрузку с пуском 3–4x.',
    runningKwTypical: [0.3, 1],
    conservativeRunningKw: 1,
    startingFactorTypical: [3, 4],
    conservativeStartingKw: 3.5,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Морозильник один или несколько?',
    sourceNote,
    aliases: [/морозил/iu, /freezer/iu]
  },
  {
    id: 'surface_pump',
    loadClass: 'motor_compressor_load',
    consumers: ['поверхностный насос', 'насосная станция'],
    importantParameters: ['тип насоса', 'мощность на шильдике', 'глубина/напор', '220/380 В'],
    howToDeterminePower: 'Лучше по шильдику; без него предварительно 0,8 кВт рабочая и около 3 кВт пусковая.',
    runningKwTypical: [0.6, 1.2],
    conservativeRunningKw: 0.8,
    startingFactorTypical: [3, 5],
    conservativeStartingKw: 3,
    confidence: 'low',
    canEstimate: true,
    preliminaryQuestion: 'Какой насос: поверхностный, скважинный или циркуляционный, 220 В или 380 В?',
    sourceNote,
    aliases: [/\bнасос\b/iu, /насосная станц/iu, /pump/iu]
  },
  {
    id: 'submersible_pump',
    loadClass: 'motor_compressor_load',
    consumers: ['скважинный насос', 'погружной насос', 'глубинный насос'],
    importantParameters: ['модель/шильдик', 'глубина', 'плавный пуск', '220/380 В'],
    howToDeterminePower: 'Желательно только по модели/шильдику; без него предварительный высокий запас.',
    runningKwTypical: [0.75, 1.5],
    conservativeRunningKw: 1.1,
    startingFactorTypical: [3, 5],
    conservativeStartingKw: 4,
    confidence: 'low',
    canEstimate: true,
    preliminaryQuestion: 'Есть модель или мощность скважинного насоса на шильдике, и он 220 В или 380 В?',
    sourceNote,
    aliases: [/скважин/iu, /погружн/iu, /глубин/iu, /submersible/iu, /well pump/iu]
  },
  {
    id: 'air_compressor',
    loadClass: 'motor_compressor_load',
    consumers: ['компрессор'],
    importantParameters: ['л.с./кВт', 'объём ресивера', '220/380 В', 'пускатель/плавный пуск'],
    howToDeterminePower: 'По шильдику; у компрессора высокий пуск, типовой ориентир 1–2,5 кВт рабочая и 3–7 кВт пусковая.',
    runningKwTypical: [1, 2.5],
    conservativeRunningKw: 2,
    startingFactorTypical: [2, 4],
    conservativeStartingKw: 4,
    confidence: 'low',
    canEstimate: true,
    preliminaryQuestion: 'Какая мощность/л.с. компрессора и он 220 В или 380 В?',
    sourceNote,
    aliases: [/компрессор/iu, /compressor/iu]
  },
  {
    id: 'pressure_washer',
    loadClass: 'motor_compressor_load',
    consumers: ['мойка высокого давления', 'Керхер'],
    importantParameters: ['модель', 'мощность двигателя', 'одновременность с другими нагрузками'],
    howToDeterminePower: 'По модели; без неё 1,2–2 кВт рабочая и 3–4 кВт пусковая.',
    runningKwTypical: [1.2, 2],
    conservativeRunningKw: 1.8,
    startingFactorTypical: [2, 3],
    conservativeStartingKw: 3.6,
    confidence: 'low',
    canEstimate: true,
    preliminaryQuestion: 'Какая модель/мощность мойки высокого давления?',
    sourceNote,
    aliases: [/мойк[аи]\s+высок/iu, /керхер/iu, /pressure washer/iu]
  },
  {
    id: 'handheld_drill',
    loadClass: 'handheld_tool_load',
    consumers: ['дрель'],
    importantParameters: ['бытовая/профессиональная', 'мощность', 'материал сверления'],
    howToDeterminePower: 'По паспорту; без него бытовая дрель обычно укладывается в 0,6–0,8 кВт, пуск около 1–1,8 кВт.',
    runningKwTypical: [0.6, 0.8],
    conservativeRunningKw: 0.8,
    startingFactorTypical: [1.2, 2.5],
    conservativeStartingKw: 1.8,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Инструмент бытовой или профессиональный?',
    sourceNote,
    aliases: [/дрел/iu, /\bdrill\b/iu]
  },
  {
    id: 'angle_grinder',
    loadClass: 'handheld_tool_load',
    consumers: ['болгарка', 'УШМ', 'углошлифовальная машина'],
    importantParameters: ['диаметр диска 115/125/180/230', 'бытовая/профессиональная', 'мощность'],
    howToDeterminePower: 'По паспорту; без него взять осторожно 1,5 кВт рабочая и до 3 кВт пусковая для бытового/среднего инструмента.',
    runningKwTypical: [0.8, 2.2],
    conservativeRunningKw: 1.5,
    startingFactorTypical: [1.2, 2],
    conservativeStartingKw: 3,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Болгарка бытовая 125 мм или большая/профессиональная 180–230 мм?',
    sourceNote,
    aliases: [/болгарк/iu, /\bушм\b/iu, /шлифмаш/iu, /grinder/iu]
  },
  {
    id: 'rotary_hammer',
    loadClass: 'handheld_tool_load',
    consumers: ['перфоратор'],
    importantParameters: ['бытовой/профессиональный', 'мощность', 'режим работ'],
    howToDeterminePower: 'По паспорту; без него 0,8–1,3 кВт рабочая, пуск до 1,5–3 кВт.',
    runningKwTypical: [0.8, 1.3],
    conservativeRunningKw: 1.3,
    startingFactorTypical: [1.2, 3],
    conservativeStartingKw: 3,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Перфоратор бытовой или тяжёлый профессиональный?',
    sourceNote,
    aliases: [/перфоратор/iu, /hammer drill/iu, /rotary hammer/iu]
  },
  {
    id: 'circular_saw',
    loadClass: 'handheld_tool_load',
    consumers: ['циркулярная пила', 'дисковая пила'],
    importantParameters: ['диаметр диска', 'мощность', 'пуск под нагрузкой'],
    howToDeterminePower: 'По паспорту; без него 1,1–1,5 кВт рабочая и 2,4–4,2 кВт пусковая.',
    runningKwTypical: [1.1, 1.5],
    conservativeRunningKw: 1.5,
    startingFactorTypical: [2, 3],
    conservativeStartingKw: 4,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Пила бытовая или строительная/профессиональная?',
    sourceNote,
    aliases: [/циркуляр/iu, /дисков[а-я]*\s+пил/iu, /circular saw/iu]
  },
  {
    id: 'electric_chain_saw',
    loadClass: 'handheld_tool_load',
    consumers: ['электропила', 'цепная пила'],
    importantParameters: ['мощность', 'длина шины', 'пуск под нагрузкой'],
    howToDeterminePower: 'По паспорту; без него 1,2–2 кВт рабочая с умеренным пусковым запасом.',
    runningKwTypical: [1.2, 2],
    conservativeRunningKw: 1.8,
    startingFactorTypical: [1, 2],
    conservativeStartingKw: 2.5,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Электропила бытовая или мощная строительная?',
    sourceNote,
    aliases: [/электропил/iu, /цепн[а-я]*\s+пил/iu, /chain saw/iu, /chainsaw/iu]
  },
  {
    id: 'jigsaw',
    loadClass: 'handheld_tool_load',
    consumers: ['электролобзик'],
    importantParameters: ['мощность', 'режим работы'],
    howToDeterminePower: 'По паспорту; без него обычно малая нагрузка 0,3–0,7 кВт.',
    runningKwTypical: [0.3, 0.7],
    conservativeRunningKw: 0.7,
    startingFactorTypical: [1, 2],
    conservativeStartingKw: 1.2,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Кроме лобзика будут более мощные инструменты?',
    sourceNote,
    aliases: [/лобзик/iu, /jig\s?saw/iu]
  },
  {
    id: 'construction_vacuum',
    loadClass: 'motor_compressor_load',
    consumers: ['строительный пылесос', 'пылесос'],
    importantParameters: ['мощность', 'запуск вместе с инструментом'],
    howToDeterminePower: 'По паспорту; без него 1–1,5 кВт рабочая и до 1,7–3 кВт пусковая.',
    runningKwTypical: [1, 1.5],
    conservativeRunningKw: 1.4,
    startingFactorTypical: [1.2, 2],
    conservativeStartingKw: 2.5,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Пылесос будет включаться одновременно с инструментом?',
    sourceNote,
    aliases: [/пылесос/iu, /vacuum/iu]
  },
  {
    id: 'concrete_mixer',
    loadClass: 'motor_compressor_load',
    consumers: ['бетономешалка'],
    importantParameters: ['объём', 'мощность двигателя', 'пуск под нагрузкой'],
    howToDeterminePower: 'По шильдику; без него 0,7–1 кВт рабочая и 2,5–3,5 кВт пусковая.',
    runningKwTypical: [0.7, 1],
    conservativeRunningKw: 1,
    startingFactorTypical: [3, 4],
    conservativeStartingKw: 3.5,
    confidence: 'low',
    canEstimate: true,
    preliminaryQuestion: 'Какой объём/мощность бетономешалки?',
    sourceNote,
    aliases: [/бетономешал/iu, /concrete mixer/iu]
  },
  {
    id: 'microwave',
    loadClass: 'heating_resistive_load',
    consumers: ['микроволновка'],
    importantParameters: ['потребляемая мощность, не только мощность СВЧ'],
    howToDeterminePower: 'По паспорту; без него 0,8–1,5 кВт, в генераторных таблицах часто закладывают до 1,6 кВт.',
    runningKwTypical: [0.8, 1.5],
    conservativeRunningKw: 1.5,
    startingFactorTypical: [1, 2],
    conservativeStartingKw: 1.6,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Микроволновка будет включаться одновременно с чайником/обогревателем?',
    sourceNote,
    aliases: [/микроволн/iu, /microwave/iu]
  },
  {
    id: 'kettle',
    loadClass: 'heating_resistive_load',
    consumers: ['электрочайник'],
    importantParameters: ['мощность на корпусе'],
    howToDeterminePower: 'Нагревательная нагрузка: почти напрямую по указанной мощности.',
    runningKwTypical: [1.5, 2.5],
    conservativeRunningKw: 2.2,
    startingFactorTypical: [1, 1],
    conservativeStartingKw: 2.2,
    confidence: 'high',
    canEstimate: true,
    preliminaryQuestion: 'Чайник будет включаться одновременно с другими мощными приборами?',
    sourceNote,
    aliases: [/чайник/iu, /kettle/iu]
  },
  {
    id: 'resistive_heater',
    loadClass: 'heating_resistive_load',
    consumers: ['обогреватель', 'конвектор', 'масляный радиатор'],
    importantParameters: ['мощность', 'количество обогревателей', 'режим'],
    howToDeterminePower: 'Нагревательная нагрузка: считать по паспортной мощности; без неё 1–2,5 кВт за прибор.',
    runningKwTypical: [1, 2.5],
    conservativeRunningKw: 2,
    startingFactorTypical: [1, 1.2],
    conservativeStartingKw: 2.4,
    confidence: 'high',
    canEstimate: true,
    preliminaryQuestion: 'Сколько обогревателей будет включаться одновременно?',
    sourceNote,
    aliases: [/обогревател/iu, /конвектор/iu, /радиатор/iu, /heater/iu]
  },
  {
    id: 'heat_gun',
    loadClass: 'heating_resistive_load',
    consumers: ['тепловая пушка', 'строительный фен'],
    importantParameters: ['электрическая или газовая', 'мощность', 'режим'],
    howToDeterminePower: 'Если электрическая — высокая нагревательная нагрузка; мощность обязательно уточнять.',
    runningKwTypical: [2, 5],
    conservativeRunningKw: 3,
    startingFactorTypical: [1, 1],
    conservativeStartingKw: 3,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Тепловая пушка электрическая? Какая мощность/режим?',
    sourceNote,
    aliases: [/теплов[а-я]*\s+пушк/iu, /строительн[а-я]*\s+фен/iu, /heat gun/iu]
  },
  {
    id: 'water_heater',
    loadClass: 'heating_resistive_load',
    consumers: ['бойлер', 'водонагреватель', 'кипятильник'],
    importantParameters: ['мощность ТЭНа', 'объём', 'одновременность с другими нагрузками'],
    howToDeterminePower: 'По мощности ТЭНа; без неё обычно 1,5–3 кВт.',
    runningKwTypical: [1.5, 3],
    conservativeRunningKw: 2,
    startingFactorTypical: [1, 1.5],
    conservativeStartingKw: 3,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Какая мощность бойлера/водонагревателя?',
    sourceNote,
    aliases: [/бойлер/iu, /водонагрев/iu, /кипятильник/iu, /boiler/iu]
  },
  {
    id: 'electric_stove',
    loadClass: 'heating_resistive_load',
    consumers: ['электроплита', 'электропечь', 'плитка'],
    importantParameters: ['количество конфорок', 'режим', 'паспортная мощность'],
    howToDeterminePower: 'Высокая нагревательная нагрузка; считать по режиму/паспорту, без него лучше уточнить.',
    runningKwTypical: [1.5, 6],
    conservativeRunningKw: 3,
    startingFactorTypical: [1, 1],
    conservativeStartingKw: 3,
    confidence: 'medium',
    canEstimate: true,
    preliminaryQuestion: 'Сколько конфорок/какая мощность электроплиты будет нужна одновременно?',
    sourceNote,
    aliases: [/электроплит/iu, /электропеч/iu, /\bплитк/iu, /stove/iu]
  },
  {
    id: 'welder_inverter',
    loadClass: 'workshop_industrial_load',
    consumers: ['сварочный инвертор', 'сварка'],
    importantParameters: ['ток сварки', 'электрод', '220/380 В', 'модель аппарата'],
    howToDeterminePower: 'Зависит от режима сварки и аппарата; без модели/тока нельзя надёжно усреднять.',
    runningKwTypical: [3, 7],
    conservativeRunningKw: 5,
    startingFactorTypical: [1, 2],
    conservativeStartingKw: 7,
    confidence: 'low',
    canEstimate: false,
    preliminaryQuestion: 'Какой сварочный аппарат/ток сварки и питание 220 В или 380 В?',
    sourceNote,
    aliases: [/сварк/iu, /welder/iu, /welding/iu]
  },
  {
    id: 'unknown_named_load',
    loadClass: 'unknown_named_load',
    consumers: ['станок', 'аппарат', 'оборудование', 'непонятный потребитель'],
    importantParameters: ['тип нагрузки', 'модель/шильдик', 'мощность', '220/380 В', 'есть ли двигатель/нагреватель'],
    howToDeterminePower: 'Не усреднять: сначала определить класс нагрузки или взять мощность с шильдика.',
    confidence: 'low',
    canEstimate: false,
    preliminaryQuestion: 'Это ручной инструмент, насос/компрессор, нагреватель или станок с двигателем? Есть модель/шильдик?',
    sourceNote,
    aliases: [/станок/iu, /аппарат/iu, /оборудован/iu, /device/iu, /machine/iu]
  }
];

function textClauses(text: string) {
  return text
    .split(/[.!?;\n]+|\s+[—–-]\s+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function referenceMatchesText(reference: GeneratorReferenceEntry, text: string) {
  const haystack = reference.runtime ? normalizeText(text) : text;
  return reference.aliases.some((alias) => alias.test(haystack));
}

function mentionRoleForReference(text: string, reference: GeneratorReferenceEntry): { role: GeneratorLoadMentionRole; evidence?: string } {
  const clauses = textClauses(text);
  const matchingClauses = clauses.filter((clause) => referenceMatchesText(reference, clause));
  const relevantText = matchingClauses.length ? matchingClauses.join(' ') : text;
  const normalized = normalizeText(relevantText);

  const directExclusion = /(?:\bбез\b|не\s+(?:нужен|нужна|нужно|использую|подключаю|планирую|будет|буду)|исключаем|убираем|отключаем)/iu.test(relevantText);
  if (directExclusion && !/(?:одновременно|вместе|разом|сразу|по\s+очереди|отдельно)/iu.test(relevantText)) {
    return { role: 'excluded', evidence: relevantText };
  }

  const nonSimultaneous = /(?:не\s+(?:буду|планирую|собираюсь|нужно|надо)?[^.!?;\n]{0,90}(?:одновременно|вместе|разом|сразу)|(?:одновременно|вместе|разом|сразу)[^.!?;\n]{0,90}не\s+(?:буду|планирую|собираюсь|нужно|надо)?|(?:по\s+очереди|отдельно|не\s+в\s+один\s+момент))/iu.test(relevantText);
  if (nonSimultaneous) return { role: 'staged', evidence: relevantText };

  const occasionalUse = matchingClauses.some((clause) => {
    const matchIndex = reference.aliases
      .map((alias) => clause.search(alias))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (matchIndex === undefined) return false;
    const before = clause.slice(Math.max(0, matchIndex - 45), matchIndex);
    const after = clause.slice(matchIndex, Math.min(clause.length, matchIndex + 45));
    return /(?:иногда|периодически|время\s+от\s+времени|по\s+необходимости|occasionally|sometimes|from\s+time\s+to\s+time|as\s+needed)\s+[\p{L}\d\s-]{0,35}$/iu.test(before) ||
      /^[\p{L}\d\s-]{0,20}(?:иногда|периодически|occasionally|sometimes|as\s+needed)/iu.test(after);
  });
  const explicitlySimultaneous = /(?:одновременно|вместе|разом|сразу)/iu.test(relevantText);
  const occasionalUseCanStage = !['resistive_light_load', 'small_electronics_load'].includes(reference.loadClass);
  if (occasionalUseCanStage && occasionalUse && !explicitlySimultaneous) return { role: 'staged', evidence: relevantText };

  if (/^(?:а\s+)?(?:что|как|почему|сколько|какой|какая|какие)\b/iu.test(normalized) && !/(?:будет|буду|надо|нужно|добавлю|подключить|запитать|работать)/iu.test(normalized)) {
    return { role: 'context', evidence: relevantText };
  }

  return { role: 'active', evidence: relevantText };
}

export function classifyGeneratorLoadText(text: string): GeneratorLoadDetection[] {
  const detections: GeneratorLoadDetection[] = [];
  const normalizedText = normalizeText(text);
  for (const reference of allGeneratorReferenceEntries()) {
    const haystack = reference.runtime ? normalizedText : text;
    const matchedAlias = reference.aliases.find((alias) => alias.test(haystack));
    if (matchedAlias) {
      const role = mentionRoleForReference(text, reference);
      detections.push({ reference, evidence: text, role: role.role, roleEvidence: role.evidence });
    }
  }
  if (detections.some((item) => item.reference.id !== 'unknown_named_load')) {
    return detections.filter((item) => item.reference.id !== 'unknown_named_load');
  }
  return detections;
}

function pushUniqueLoad(items: ProductElectricalLoadItem[], item: ProductElectricalLoadItem) {
  if (items.some((existing) => existing.kind === item.kind && existing.name === item.name)) return;
  items.push(item);
}

function generatorReferenceLoadItemsFromDetections(
  text: string,
  detections: GeneratorLoadDetection[],
  evidenceSuffix = ''
): ProductElectricalLoadItem[] {
  const items: ProductElectricalLoadItem[] = [];
  const evidence = evidenceSuffix ? `${text} | ${evidenceSuffix}` : text;
  if (detections.some((item) => item.reference.loadClass === 'resistive_light_load')) {
    pushUniqueLoad(items, { kind: 'lighting', name: 'свет', count: 1, runningKw: 0.2, startingKw: 0.2, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.loadClass === 'small_electronics_load')) {
    pushUniqueLoad(items, { kind: 'small_electronics', name: 'мелкая электроника', count: 1, runningKw: 0.2, startingKw: 0.2, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.loadClass === 'handheld_tool_load')) {
    const startingKw = detections.some((item) => ['circular_saw', 'angle_grinder', 'rotary_hammer'].includes(item.reference.id)) ? 3 : 1.8;
    pushUniqueLoad(items, { kind: 'handheld_tool', name: 'ручной электроинструмент', count: 1, runningKw: 1.5, startingKw, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.id === 'submersible_pump')) {
    pushUniqueLoad(items, { kind: 'pump', name: 'скважинный насос', count: 1, runningKw: 1.1, startingKw: 4, source: 'estimated_average', evidence });
  } else if (detections.some((item) => item.reference.id === 'surface_pump')) {
    pushUniqueLoad(items, { kind: 'pump', name: 'насос', count: 1, runningKw: 0.8, startingKw: 3, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.id === 'refrigerator')) {
    pushUniqueLoad(items, { kind: 'refrigerator', name: 'холодильник', count: 1, runningKw: 0.25, startingKw: 1.2, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.id === 'freezer')) {
    pushUniqueLoad(items, { kind: 'freezer', name: 'морозильник', count: 1, runningKw: 1, startingKw: 3.5, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.id === 'air_compressor')) {
    pushUniqueLoad(items, { kind: 'compressor', name: 'компрессор', count: 1, runningKw: 2, startingKw: 4, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.id === 'pressure_washer')) {
    pushUniqueLoad(items, { kind: 'pressure_washer', name: 'мойка высокого давления', count: 1, runningKw: 1.8, startingKw: 3.6, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.id === 'construction_vacuum')) {
    pushUniqueLoad(items, { kind: 'vacuum', name: 'пылесос', count: 1, runningKw: 1.4, startingKw: 2.5, source: 'estimated_average', evidence });
  }
  if (detections.some((item) => item.reference.id === 'concrete_mixer')) {
    pushUniqueLoad(items, { kind: 'concrete_mixer', name: 'бетономешалка', count: 1, runningKw: 1, startingKw: 3.5, source: 'estimated_average', evidence });
  }
  const heating = detections.filter((item) => item.reference.loadClass === 'heating_resistive_load' && item.reference.canEstimate);
  if (heating.length) {
    const largest = heating.reduce((best, current) => (current.reference.conservativeRunningKw ?? 0) > (best.reference.conservativeRunningKw ?? 0) ? current : best, heating[0]);
    const runningKw = largest.reference.conservativeRunningKw ?? 2;
    pushUniqueLoad(items, { kind: 'heating_resistive', name: largest.reference.consumers[0], count: 1, runningKw, startingKw: largest.reference.conservativeStartingKw ?? runningKw, source: 'estimated_average', evidence });
  }
  for (const detection of detections.filter((item) => item.reference.runtime && item.reference.canEstimate)) {
    const reference = detection.reference;
    const runningKw = reference.conservativeRunningKw;
    if (!runningKw) continue;
    pushUniqueLoad(items, {
      kind: reference.loadClass,
      name: reference.consumers[0],
      count: 1,
      runningKw,
      startingKw: reference.conservativeStartingKw ?? runningKw,
      source: 'web_average',
      evidence: `${evidence} | ${reference.sourceNote}`
    });
  }
  return items;
}

export function generatorReferenceLoadItemsFromText(text: string): ProductElectricalLoadItem[] {
  return generatorReferenceLoadItemsFromDetections(
    text,
    classifyGeneratorLoadText(text).filter((item) => item.role === 'active')
  );
}

export function generatorReferenceStagedLoadItemsFromText(text: string): ProductElectricalLoadItem[] {
  return generatorReferenceLoadItemsFromDetections(
    text,
    classifyGeneratorLoadText(text).filter((item) => item.role === 'staged'),
    'staged optional/separate scenario'
  );
}

export function generatorReferenceSummaryForPrompt(text: string) {
  return classifyGeneratorLoadText(text).map(({ reference }) => ({
    id: reference.id,
    loadClass: reference.loadClass,
    consumers: reference.consumers,
    runningKwTypical: reference.runningKwTypical,
    conservativeRunningKw: reference.conservativeRunningKw,
    startingFactorTypical: reference.startingFactorTypical,
    conservativeStartingKw: reference.conservativeStartingKw,
    confidence: reference.confidence,
    canEstimate: reference.canEstimate,
    preliminaryQuestion: reference.preliminaryQuestion
  }));
}

function extractTextFromOpenAIResponse(response: unknown): string {
  const value = response as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> };
  if (typeof value?.output_text === 'string') return value.output_text;
  return (value?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

function parseJsonObject(text: string): unknown {
  const direct = text.trim();
  try { return JSON.parse(direct); } catch {}
  const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced); } catch {}
  }
  const objectMatch = direct.match(/\{[\s\S]*\}/);
  if (objectMatch) return JSON.parse(objectMatch[0]);
  throw new Error('No JSON object found in generator load enrichment response');
}

export async function enrichGeneratorLoadReferenceFromWeb(
  client: { responses: { create: (request: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown> } },
  text: string,
  signal?: AbortSignal
): Promise<PersistedGeneratorReferenceEntry | null> {
  if (!shouldEnrichGeneratorLoadReference(text)) return null;
  const response = await client.responses.create({
    model: process.env.OPENAI_FACT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    tools: [{ type: 'web_search_preview', search_context_size: 'low' }],
    tool_choice: { type: 'web_search_preview' },
    max_output_tokens: 1200,
    input: [{
      role: 'user',
      content: [
        'Найди по вебу типовую потребляемую мощность и пусковую/особенности ОДНОГО неизвестного электропотребителя для подбора генератора.',
        'Верни только JSON object без markdown. Не выдумывай точность: если данных мало, canEstimate=false и confidence=low.',
        'Schema: {"id":"latin_or_cyrillic_slug","loadClass":"resistive_light_load|small_electronics_load|motor_compressor_load|handheld_tool_load|heating_resistive_load|workshop_industrial_load|unknown_named_load","consumers":["..."],"aliases":["..."],"importantParameters":["..."],"howToDeterminePower":"...","runningKwTypical":[min,max],"conservativeRunningKw":number,"startingFactorTypical":[min,max],"conservativeStartingKw":number,"confidence":"high|medium|low","canEstimate":boolean,"preliminaryQuestion":"...","sourceNote":"web_average: short sources/domains and caveat"}.',
        `Buyer text: ${text}`
      ].join('\n')
    }]
  }, signal ? { signal } : undefined);
  const parsed = parseJsonObject(extractTextFromOpenAIResponse(response));
  const sanitized = sanitizePersistedEntry(parsed);
  if (!sanitized) return null;
  return upsertGeneratorLoadReferenceEntry(sanitized);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertNonRepeatingProductionDialogue,
  dialogueSignature
} from './productionLiveDialoguePolicy.mjs';

export const productionLiveScenarioVariants = {
  workshop_welder_compressor_bundle: {
    persona: 'Практичный мастер гаражной мастерской: сравнивает запас мощности, задает вопросы по эксплуатации, заявку сразу не оставляет.',
    leadMode: 'selection_only',
    description: 'Workshop buyer compares generator power for welder and compressor, then switches to concrete mixer and delivery terms.',
    turns: [
      {
        phase: 'workshop_generator_need',
        user: 'Здравствуйте. В гараж-мастерскую нужен генератор: сварочный инвертор, компрессор 2 кВт, болгарка и свет. Не понимаю, брать 7-8 кВт или уже 10 кВт с запасом?'
      },
      {
        phase: 'voltage_and_starting_loads',
        user: 'Компрессор запускается тяжело. Если генератор будет на 220 В, он нормально переживет пуск или лучше смотреть трехфазный?'
      },
      {
        phase: 'catalog_8_10kw_petrol',
        user: 'Покажите тогда из каталога бензиновые варианты примерно 8-10 кВт, чтобы не самые дорогие, но без совсем слабых моделей.'
      },
      {
        phase: 'noise_service_question',
        user: 'А по шуму и обслуживанию что важно? Он будет работать не каждый день, но иногда по 4-5 часов подряд.'
      },
      {
        phase: 'switch_to_concrete_mixer',
        user: 'Еще для той же бригады нужна бетономешалка под мелкие заливки во дворе. Объем нужен не игрушечный, но чтобы двое людей спокойно перевозили.'
      },
      {
        phase: 'catalog_mixer_midrange',
        user: 'Покажите несколько подходящих бетономешалок среднего объема из каталога и объясните, чем они отличаются по задаче.'
      },
      {
        phase: 'delivery_without_exact_promise',
        user: 'Если брать генератор и бетономешалку вместе, доставка в Таганрог у вас бывает? Как это обычно считают?'
      },
      {
        phase: 'final_summary',
        user: 'Ну и что бы вы сейчас взяли по генератору и бетономешалке? Что мне еще посмотреть дома перед заказом?'
      }
    ]
  },
  farm_pump_generator_plate: {
    persona: 'Хозяин небольшого хозяйства: осторожно выбирает резервное питание для насоса и морозильника, затем подбирает виброплиту для подъезда.',
    leadMode: 'selection_only',
    description: 'Farm buyer needs generator for pump and freezer, asks about inverter, then switches to plate compactor for gravel and pavers.',
    turns: [
      {
        phase: 'farm_generator_need',
        user: 'Добрый день. Для небольшого хозяйства нужен генератор: глубинный насос, морозильник, освещение и иногда электроинструмент. Какую мощность реально смотреть?'
      },
      {
        phase: 'inverter_or_regular',
        user: 'Морозильник и насос не испортятся от обычного генератора? Или для такой техники обязательно нужен инверторный?'
      },
      {
        phase: 'catalog_generator_not_overpay',
        user: 'Покажите варианты из каталога, где есть нормальный запас под насос, но без переплаты за промышленный уровень.'
      },
      {
        phase: 'fuel_runtime_question',
        user: 'По расходу топлива и времени работы на баке что примерно учитывать? Мне важно, чтобы ночью не бегать каждые два часа.'
      },
      {
        phase: 'switch_to_plate_compactor',
        user: 'И еще нужна виброплита для подъезда: щебень, песок, потом плитка. Мне не профессиональная трасса, но чтобы основание не просело.'
      },
      {
        phase: 'plate_weight_choice',
        user: 'Вес 70-80 кг хватит или лучше 90-110 кг? Грузить буду в прицеп, поэтому слишком тяжелую тоже не хочу.'
      },
      {
        phase: 'catalog_plate_90_110',
        user: 'Покажите из каталога виброплиты около 90-110 кг и скажите, где нужен коврик под плитку.'
      },
      {
        phase: 'summary_and_specialist_boundary',
        user: 'Какие модели мне в итоге смотреть? И по доставке с наличием как обычно понятно становится?'
      }
    ]
  },
  short_generator_plate_delivery: {
    persona: 'Владелец участка с ограниченным бюджетом: быстро сужает выбор генератора и виброплиты, пока прикидывает доставку и скидку.',
    leadMode: 'commercial_question',
    description: 'Short final gate: buyer sizes a generator, asks inverter risk, switches to plate compactor, requests catalog plates, then asks delivery/discount boundary.',
    turns: [
      {
        phase: 'generator_sizing_short',
        user: 'Добрый день. Для участка нужен генератор: скважинный насос примерно 1 кВт, холодильник, свет и иногда болгарка. Не хочу брать огромный с лишним запасом, какой диапазон мощности смотреть?'
      },
      {
        phase: 'generator_inverter_risk_short',
        user: 'Если насос стартует тяжело, обычный генератор с AVR нормально подойдет или для холодильника и насоса обязательно нужен инверторный?'
      },
      {
        phase: 'plate_need_short',
        user: 'Еще отдельная задача: надо уплотнить подъезд перед плиткой, там щебень и песок. Слишком тяжелую плиту не хочу, но легкую боюсь взять зря.'
      },
      {
        phase: 'plate_weight_choice',
        user: 'Для такого подъезда 70-80 кг хватит или лучше смотреть 90-110 кг? Грузить буду в прицеп, поэтому вес тоже важен.'
      },
      {
        phase: 'plate_catalog_90_120kg_cheap',
        user: 'Покажите из каталога виброплиты 90-120 кг, желательно без самых дорогих моделей, и поясните, где нужен коврик под плитку.'
      },
      {
        phase: 'delivery_discount_question',
        user: 'А доставка и скидка бывают? Мне пока просто понять, на что рассчитывать.'
      }
    ]
  },
  short_pump_plate_order_boundary: {
    persona: 'Домовладелец без точных характеристик насоса: отвечает на уточнения, просит предварительный подбор, затем переключается на въезд.',
    leadMode: 'commercial_question',
    description: 'Short final gate: buyer asks backup power for pump and fridge, switches to plate compactor, then asks safe delivery/order boundary.',
    turns: [
      {
        phase: 'backup_power_need_short',
        user: 'Здравствуйте. Подбираю резервное питание для дома: насос в скважине, холодильник, свет и иногда небольшой инструмент. Хочу понять разумный запас, без покупки слишком мощного генератора.'
      },
      {
        phase: 'pump_details_unknown_power_short',
        user: 'Насос скважинный, обычный 220 В. Мощность точно не помню, шильдик сейчас не вижу, вроде около 1 кВт. На таких данных уже можно понять, какую мощность генератора смотреть?'
      },
      {
        phase: 'backup_power_avr_short',
        user: 'А обычный генератор с AVR для холодильника и насоса нормально подойдет или лучше обязательно инверторный?'
      },
      {
        phase: 'plate_driveway_need_short',
        user: 'Еще нужна виброплита для въезда: основание щебень с песком, сверху будет плитка. Нужен не профессиональный монстр, а нормальный вариант для частного участка.'
      },
      {
        phase: 'plate_weight_choice',
        user: 'Если брать по весу, 80 кг еще нормально или для такого основания лучше около 100 кг? Перевозить планирую сам, поэтому 150 кг не хочу.'
      },
      {
        phase: 'plate_catalog_90_120kg_cheap',
        user: 'Дайте из каталога варианты виброплит примерно 90-120 кг, лучше в адекватном бюджете, и отдельно поясните про резиновый коврик для плитки.'
      },
      {
        phase: 'delivery_discount_question',
        user: 'А по доставке, наличию и скидке что можете сказать? Или это уже перед покупкой уточняется?'
      }
    ]
  },
  rental_team_diesel_generator_trowel: {
    persona: 'Ответственный за прокатную бригаду: выбирает технику под коммерческую нагрузку и больше ценит ресурс, сервис и поставку.',
    leadMode: 'selection_only',
    description: 'Rental team asks for diesel generator under tools, compares engines, then switches to finishing concrete equipment.',
    turns: [
      {
        phase: 'rental_diesel_generator_need',
        user: 'Здравствуйте. Для прокатной бригады нужен дизельный генератор: перфораторы, резчик, освещение, иногда насос. Хочу надежный вариант не на один сезон.'
      },
      {
        phase: 'power_range_and_voltage',
        user: 'По мощности думаю 12-16 кВт, но не уверен. 380 В может пригодиться, хотя часть инструмента обычная на 220 В.'
      },
      {
        phase: 'catalog_diesel_12_16kw',
        user: 'Подберите из каталога дизельные генераторы в этом диапазоне и не показывайте бытовые бензиновые, они не про эту задачу.'
      },
      {
        phase: 'engine_reliability_question',
        user: 'Если выбирать по двигателю и ремонтопригодности, на что смотреть? Мне важнее ресурс и сервис, чем самая низкая цена.'
      },
      {
        phase: 'switch_to_concrete_finishing',
        user: 'Еще нужен инструмент для заглаживания бетона после заливки площадок. Ручным правилом уже не справляемся.'
      },
      {
        phase: 'catalog_trowel_or_related',
        user: 'Покажите, что есть для заглаживания бетона, и объясните, для каких объемов это имеет смысл.'
      },
      {
        phase: 'availability_boundary',
        user: 'По наличию и срокам поставки сможете точно сказать сейчас или это надо отдельно проверять?'
      },
      {
        phase: 'final_decision_summary',
        user: 'Коротко подскажите, на чем остановиться по генератору и по бетону? Что мне еще уточнить у ребят на объекте?'
      }
    ]
  },
  ready_owner_generator_plate_lead: {
    persona: 'Готовый к покупке владелец дома: после подбора просит уточнить наличие и доставку, сам оставляет имя и телефон.',
    leadMode: 'contact_ready',
    description: 'Ready homeowner narrows generator and plate compactor choices, then leaves contact details for availability and delivery verification.',
    turns: [
      {
        phase: 'home_backup_generator_need',
        user: 'Здравствуйте. Нужен генератор для дома в Азове: скважинный насос, холодильник, котел и свет. Хочу нормальный запас, но без промышленного уровня.'
      },
      {
        phase: 'known_pump_and_boiler_details',
        user: 'Насос 220 В, примерно 750 Вт, котел газовый с электроникой, холодильник один. Инструмент с генератором включать не планирую.'
      },
      {
        phase: 'catalog_generator_ready_choice',
        user: 'Покажите пару нормальных вариантов генераторов из каталога, чтобы можно было выбрать сегодня.'
      },
      {
        phase: 'driveway_plate_need',
        user: 'Еще нужна виброплита для въезда под плитку. Основание песок и щебень, площадь небольшая, таскать буду сам.'
      },
      {
        phase: 'plate_catalog_ready_choice',
        user: 'Покажите виброплиты примерно 80-100 кг и скажите, нужен ли коврик под плитку.'
      },
      {
        phase: 'lead_contact_for_order_check',
        user: 'Понял. Тогда давайте заявку: меня зовут Алексей, телефон +7 900 000-00-11. Нужно уточнить наличие выбранного генератора, виброплиты и доставку до Азова.'
      }
    ]
  }
};

export function defaultProductionLiveScenarioVariant(now = new Date()) {
  const names = Object.keys(productionLiveScenarioVariants);
  const dayIndex = Math.floor(now.getTime() / 86_400_000);
  return names[dayIndex % names.length];
}

export function getScenarioVariant(name) {
  const variant = productionLiveScenarioVariants[name];
  if (!variant) {
    const error = new Error('unknown_production_live_scenario_variant');
    error.details = {
      requested: name,
      available: Object.keys(productionLiveScenarioVariants)
    };
    throw error;
  }
  return variant;
}

export async function prepareProductionLiveDialogueScenario({
  variantName = process.env.PRODUCTION_LIVE_SCENARIO_VARIANT,
  outputDir = process.env.PRODUCTION_LIVE_SCENARIO_OUTPUT_DIR || path.join('local-live-tests', 'generated-production-live-scenarios'),
  artifactDir = 'local-live-tests',
  now = new Date(),
  env = process.env
} = {}) {
  const resolvedVariantName = variantName || defaultProductionLiveScenarioVariant(now);
  const variant = getScenarioVariant(resolvedVariantName);
  const safeStamp = now.toISOString().replace(/[:.]/g, '-');
  const scenarioName = `final-live-${resolvedVariantName}-${safeStamp}`;
  const turns = variant.turns;
  const policy = await assertNonRepeatingProductionDialogue({
    scriptName: 'prepareProductionLiveDialogueScenario',
    scenarioName,
    turns,
    artifactDir,
    env
  });
  const scenario = {
    scenarioName,
    variantName: resolvedVariantName,
    persona: variant.persona,
    leadMode: variant.leadMode,
    description: variant.description,
    createdAt: now.toISOString(),
    dialogueSignature: dialogueSignature(turns),
    productionLivePolicy: policy,
    turns
  };

  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${scenarioName}.json`);
  await fs.writeFile(outputPath, JSON.stringify(scenario, null, 2), 'utf8');

  return {
    outputPath,
    scenario,
    commandEnv: {
      RUN_REMEDIATION_POSTDEPLOY_LIVE: '1',
      ALLOW_PRODUCTION_LIVE_TESTS: '1',
      FINAL_RELEASE_LIVE_GATE: '1',
      PRODUCTION_LIVE_DIALOGUE_FILE: outputPath
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    console.log(JSON.stringify({
      ok: true,
      defaultVariant: defaultProductionLiveScenarioVariant(),
      variants: Object.entries(productionLiveScenarioVariants).map(([name, variant]) => ({
        name,
        persona: variant.persona,
        leadMode: variant.leadMode,
        turnCount: variant.turns.length,
        description: variant.description
      }))
    }, null, 2));
    return;
  }
  const variantArg = args.find((arg) => arg.startsWith('--variant='));
  const result = await prepareProductionLiveDialogueScenario({
    variantName: variantArg ? variantArg.slice('--variant='.length) : undefined
  });
  console.log(JSON.stringify({
    ok: true,
    outputPath: result.outputPath,
    scenarioName: result.scenario.scenarioName,
    variantName: result.scenario.variantName,
    dialogueSignature: result.scenario.dialogueSignature,
    turnCount: result.scenario.turns.length,
    commandEnv: result.commandEnv
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      details: error?.details
    }, null, 2));
    process.exit(1);
  });
}

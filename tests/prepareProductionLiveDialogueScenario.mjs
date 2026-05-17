import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertNonRepeatingProductionDialogue,
  dialogueSignature
} from './productionLiveDialoguePolicy.mjs';

export const productionLiveScenarioVariants = {
  workshop_welder_compressor_bundle: {
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
        user: 'Если брать генератор и бетономешалку вместе, доставка в Таганрог возможна? Точную цену сейчас не обещайте, хочу понять порядок действий.'
      },
      {
        phase: 'final_summary_no_contact',
        user: 'Пока номер не оставляю. Суммируйте, что мне выбрать по генератору, что по бетономешалке и какие данные подготовить перед точным расчетом.'
      }
    ]
  },
  farm_pump_generator_plate: {
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
        user: 'Итогом напишите, какие модели смотреть и что по доставке/наличию надо будет уточнить у специалиста, без обещаний точной цены.'
      }
    ]
  },
  rental_team_diesel_generator_trowel: {
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
        user: 'Соберите краткий план выбора: генератор, оборудование для бетона, какие характеристики мне нужно уточнить перед заявкой.'
      }
    ]
  }
};

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
  variantName = process.env.PRODUCTION_LIVE_SCENARIO_VARIANT || 'workshop_welder_compressor_bundle',
  outputDir = process.env.PRODUCTION_LIVE_SCENARIO_OUTPUT_DIR || path.join('local-live-tests', 'generated-production-live-scenarios'),
  artifactDir = 'local-live-tests',
  now = new Date(),
  env = process.env
} = {}) {
  const variant = getScenarioVariant(variantName);
  const safeStamp = now.toISOString().replace(/[:.]/g, '-');
  const scenarioName = `final-live-${variantName}-${safeStamp}`;
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
    variantName,
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
  const result = await prepareProductionLiveDialogueScenario();
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

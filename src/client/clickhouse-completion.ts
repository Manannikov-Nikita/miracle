import type { SqlFunction, SqlFunctionCatalog } from "../shared/types";
import type { SqlSuggestion } from "./sql-completion";

export const clickhouseKeywords = [
  "ARRAY JOIN",
  "LEFT ARRAY JOIN",
  "PREWHERE",
  "FINAL",
  "SAMPLE",
  "LIMIT BY",
  "LIMIT WITH TIES",
  "WITH TOTALS",
  "WITH ROLLUP",
  "WITH CUBE",
  "WITH FILL",
  "GLOBAL IN",
  "GLOBAL JOIN",
  "ASOF JOIN",
  "LEFT ASOF JOIN",
  "ANY JOIN",
  "LEFT ANY JOIN",
  "SEMI JOIN",
  "ANTI JOIN",
  "SETTINGS",
  "FORMAT",
  "QUALIFY",
];

// A small offline vocabulary. Connected servers supply the authoritative names.
// Signatures are documentation only: insertion leaves existing parentheses intact.
const scalarDefinitions: [string, string, string][] = [
  ["array", "array(x, ...)", "Создаёт массив из значений общего типа."],
  [
    "arrayMap",
    "arrayMap(func, arr, ...)",
    "Применяет лямбда-функцию к каждому элементу массива.",
  ],
  [
    "arrayFilter",
    "arrayFilter(func, arr, ...)",
    "Оставляет элементы массива, удовлетворяющие условию лямбда-функции.",
  ],
  [
    "arrayJoin",
    "arrayJoin(arr)",
    "Разворачивает элементы массива в отдельные строки.",
  ],
  [
    "arrayReduce",
    "arrayReduce(aggregate_name, arr, ...)",
    "Применяет указанную агрегатную функцию к массивам.",
  ],
  [
    "arrayReduceInRanges",
    "arrayReduceInRanges(aggregate_name, ranges, arr, ...)",
    "Агрегирует значения в заданных диапазонах массивов.",
  ],
  [
    "arrayFold",
    "arrayFold(func, arr, ..., accumulator)",
    "Сворачивает элементы массива в значение аккумулятора.",
  ],
  [
    "arrayZip",
    "arrayZip(arr1, ...)",
    "Объединяет соответствующие элементы массивов в кортежи.",
  ],
  [
    "arrayZipUnaligned",
    "arrayZipUnaligned(arr1, ...)",
    "Объединяет массивы разной длины в кортежи, дополняя отсутствующие элементы NULL.",
  ],
  [
    "arrayEnumerate",
    "arrayEnumerate(arr)",
    "Возвращает индексы элементов массива, начиная с единицы.",
  ],
  [
    "arrayEnumerateUniq",
    "arrayEnumerateUniq(arr, ...)",
    "Нумерует вхождения каждого значения массива.",
  ],
  [
    "arrayEnumerateDense",
    "arrayEnumerateDense(arr)",
    "Возвращает порядковый номер первого появления каждого значения.",
  ],
  [
    "arrayDistinct",
    "arrayDistinct(arr)",
    "Возвращает уникальные элементы массива.",
  ],
  [
    "arrayUniq",
    "arrayUniq(arr, ...)",
    "Считает уникальные элементы или кортежи соответствующих элементов массивов.",
  ],
  [
    "arrayCompact",
    "arrayCompact(arr)",
    "Удаляет последовательные повторения элементов.",
  ],
  [
    "arraySort",
    "arraySort([func,] arr, ...)",
    "Сортирует массив по возрастанию.",
  ],
  [
    "arrayReverseSort",
    "arrayReverseSort([func,] arr, ...)",
    "Сортирует массив по убыванию.",
  ],
  [
    "arrayReverse",
    "arrayReverse(arr)",
    "Меняет порядок элементов массива на обратный.",
  ],
  [
    "arraySlice",
    "arraySlice(arr, offset[, length])",
    "Извлекает срез массива; смещения начинаются с единицы.",
  ],
  [
    "arrayResize",
    "arrayResize(arr, size[, extender])",
    "Изменяет длину массива с необязательным значением для заполнения.",
  ],
  ["arrayConcat", "arrayConcat(arr1, ...)", "Объединяет массивы."],
  [
    "arrayFlatten",
    "arrayFlatten(arr)",
    "Преобразует вложенный массив в одномерный.",
  ],
  [
    "arrayIntersect",
    "arrayIntersect(arr1, ...)",
    "Возвращает элементы, присутствующие во всех массивах.",
  ],
  [
    "arrayDifference",
    "arrayDifference(arr)",
    "Вычисляет разности соседних элементов.",
  ],
  [
    "arrayCumSum",
    "arrayCumSum([func,] arr, ...)",
    "Возвращает накопленные суммы элементов массива.",
  ],
  [
    "arraySum",
    "arraySum([func,] arr, ...)",
    "Суммирует элементы массива или результаты лямбда-функции.",
  ],
  [
    "arrayAvg",
    "arrayAvg([func,] arr, ...)",
    "Вычисляет среднее элементов массива или результатов лямбда-функции.",
  ],
  [
    "arrayMin",
    "arrayMin([func,] arr, ...)",
    "Возвращает минимум элементов массива или результатов лямбда-функции.",
  ],
  [
    "arrayMax",
    "arrayMax([func,] arr, ...)",
    "Возвращает максимум элементов массива или результатов лямбда-функции.",
  ],
  [
    "arrayCount",
    "arrayCount([func,] arr, ...)",
    "Считает элементы массива, удовлетворяющие условию.",
  ],
  [
    "arrayExists",
    "arrayExists(func, arr, ...)",
    "Проверяет, удовлетворяет ли хотя бы один элемент массива условию.",
  ],
  [
    "arrayAll",
    "arrayAll(func, arr, ...)",
    "Проверяет, удовлетворяют ли все элементы массива условию.",
  ],
  [
    "arrayFirst",
    "arrayFirst(func, arr, ...)",
    "Возвращает первый подходящий элемент или значение типа по умолчанию.",
  ],
  [
    "arrayFirstOrNull",
    "arrayFirstOrNull(func, arr, ...)",
    "Возвращает первый подходящий элемент или NULL.",
  ],
  [
    "arrayFirstIndex",
    "arrayFirstIndex(func, arr, ...)",
    "Возвращает индекс первого подходящего элемента, начиная с единицы, или ноль.",
  ],
  [
    "arrayLast",
    "arrayLast(func, arr, ...)",
    "Возвращает последний подходящий элемент или значение типа по умолчанию.",
  ],
  [
    "arrayLastOrNull",
    "arrayLastOrNull(func, arr, ...)",
    "Возвращает последний подходящий элемент или NULL.",
  ],
  [
    "arrayElement",
    "arrayElement(arr, index)",
    "Возвращает элемент массива по индексу, начиная с единицы.",
  ],
  [
    "arrayElementOrNull",
    "arrayElementOrNull(arr, index)",
    "Возвращает элемент массива или NULL, если индекс вне границ.",
  ],
  [
    "arrayPushBack",
    "arrayPushBack(arr, x)",
    "Добавляет элемент в конец массива.",
  ],
  [
    "arrayPushFront",
    "arrayPushFront(arr, x)",
    "Добавляет элемент в начало массива.",
  ],
  ["arrayPopBack", "arrayPopBack(arr)", "Удаляет последний элемент массива."],
  ["arrayPopFront", "arrayPopFront(arr)", "Удаляет первый элемент массива."],
  [
    "arrayStringConcat",
    "arrayStringConcat(arr[, separator])",
    "Соединяет элементы массива в строку.",
  ],
  ["has", "has(arr, value)", "Проверяет, содержит ли массив значение."],
  [
    "hasAll",
    "hasAll(arr, subset)",
    "Проверяет, содержит ли массив все элементы подмножества.",
  ],
  [
    "hasAny",
    "hasAny(arr1, arr2)",
    "Проверяет, есть ли у массивов общие элементы.",
  ],
  [
    "indexOf",
    "indexOf(arr, value)",
    "Возвращает позицию значения, начиная с единицы, или ноль.",
  ],
  ["empty", "empty(value)", "Проверяет, пуст ли массив или строка."],
  [
    "notEmpty",
    "notEmpty(value)",
    "Проверяет, содержит ли массив или строка элементы.",
  ],
  [
    "length",
    "length(value)",
    "Возвращает число элементов массива или длину строки в байтах.",
  ],
  [
    "range",
    "range([start,] end[, step])",
    "Создаёт массив целых чисел в заданном диапазоне.",
  ],
  [
    "splitByChar",
    "splitByChar(separator, s)",
    "Разбивает строку в массив по односимвольному разделителю.",
  ],
  [
    "splitByString",
    "splitByString(separator, s)",
    "Разбивает строку по строковому разделителю.",
  ],
  ["toDate", "toDate(value[, timezone])", "Преобразует значение в Date."],
  [
    "toDateTime",
    "toDateTime(value[, timezone])",
    "Преобразует значение в DateTime.",
  ],
  [
    "toDateTime64",
    "toDateTime64(value, precision[, timezone])",
    "Преобразует значение в метку времени с долями секунды.",
  ],
  [
    "parseDateTimeBestEffort",
    "parseDateTimeBestEffort(s[, timezone])",
    "Распознаёт дату и время из строки поддерживаемого формата.",
  ],
  [
    "formatDateTime",
    "formatDateTime(datetime, format[, timezone])",
    "Форматирует дату и время по заданному шаблону.",
  ],
  [
    "toStartOfDay",
    "toStartOfDay(value)",
    "Округляет дату и время до начала дня.",
  ],
  [
    "toStartOfWeek",
    "toStartOfWeek(value[, mode[, timezone]])",
    "Округляет дату и время до начала недели.",
  ],
  [
    "toStartOfMonth",
    "toStartOfMonth(value)",
    "Округляет дату до первого дня месяца.",
  ],
  [
    "toStartOfQuarter",
    "toStartOfQuarter(value)",
    "Округляет дату до первого дня квартала.",
  ],
  [
    "toStartOfYear",
    "toStartOfYear(value)",
    "Округляет дату до первого дня года.",
  ],
  ["toStartOfHour", "toStartOfHour(value)", "Округляет время до начала часа."],
  [
    "toStartOfMinute",
    "toStartOfMinute(value)",
    "Округляет время до начала минуты.",
  ],
  [
    "toStartOfInterval",
    "toStartOfInterval(value, INTERVAL x unit[, timezone])",
    "Округляет дату и время до границы заданного интервала.",
  ],
  ["toYear", "toYear(value)", "Извлекает год."],
  ["toMonth", "toMonth(value)", "Извлекает номер месяца."],
  ["toDayOfMonth", "toDayOfMonth(value)", "Извлекает день месяца."],
  [
    "toDayOfWeek",
    "toDayOfWeek(value[, mode[, timezone]])",
    "Извлекает день недели.",
  ],
  ["toHour", "toHour(value)", "Извлекает час."],
  [
    "dateDiff",
    "dateDiff(unit, start, end[, timezone])",
    "Считает границы заданных единиц времени между двумя значениями.",
  ],
  [
    "dateTrunc",
    "dateTrunc(unit, value[, timezone])",
    "Усекает дату и время до заданной точности.",
  ],
  ["addDays", "addDays(value, num)", "Прибавляет указанное число дней."],
  ["addMonths", "addMonths(value, num)", "Прибавляет указанное число месяцев."],
  [
    "now",
    "now([timezone])",
    "Возвращает текущее время на момент анализа запроса.",
  ],
  [
    "now64",
    "now64([precision[, timezone]])",
    "Возвращает текущее время с долями секунды.",
  ],
  ["today", "today()", "Возвращает текущую дату."],
  ["yesterday", "yesterday()", "Возвращает вчерашнюю дату."],
  [
    "if",
    "if(condition, then, else)",
    "Выбирает одно из двух выражений по условию.",
  ],
  [
    "multiIf",
    "multiIf(cond1, then1, ..., else)",
    "Выбирает первое выражение с истинным условием.",
  ],
  [
    "ifNull",
    "ifNull(value, alternative)",
    "Заменяет NULL альтернативным значением.",
  ],
  ["nullIf", "nullIf(x, y)", "Возвращает NULL, если аргументы равны."],
  [
    "coalesce",
    "coalesce(x, ...)",
    "Возвращает первый аргумент, не равный NULL.",
  ],
  ["isNull", "isNull(x)", "Проверяет, равно ли значение NULL."],
  [
    "assumeNotNull",
    "assumeNotNull(x)",
    "Убирает Nullable из типа; результат для NULL произволен.",
  ],
  ["toString", "toString(value)", "Преобразует значение в строку."],
  [
    "toInt64",
    "toInt64(value)",
    "Преобразует значение в знаковое 64-битное целое.",
  ],
  [
    "toUInt64",
    "toUInt64(value)",
    "Преобразует значение в беззнаковое 64-битное целое.",
  ],
  [
    "toFloat64",
    "toFloat64(value)",
    "Преобразует значение в 64-битное число с плавающей точкой.",
  ],
  [
    "toTypeName",
    "toTypeName(value)",
    "Возвращает имя типа выражения в ClickHouse.",
  ],
  ["CAST", "CAST(value AS type)", "Преобразует выражение в указанный тип."],
  ["concat", "concat(s1, ...)", "Соединяет строки."],
  [
    "substring",
    "substring(s, offset[, length])",
    "Извлекает подстроку; смещения начинаются с единицы.",
  ],
  ["lower", "lower(s)", "Переводит буквы ASCII в нижний регистр."],
  ["lowerUTF8", "lowerUTF8(s)", "Переводит текст UTF-8 в нижний регистр."],
  ["upper", "upper(s)", "Переводит буквы ASCII в верхний регистр."],
  [
    "replaceAll",
    "replaceAll(s, pattern, replacement)",
    "Заменяет все вхождения подстроки.",
  ],
  [
    "replaceRegexpAll",
    "replaceRegexpAll(s, pattern, replacement)",
    "Заменяет все совпадения с регулярным выражением.",
  ],
  [
    "match",
    "match(s, pattern)",
    "Проверяет строку на соответствие регулярному выражению RE2.",
  ],
  [
    "extract",
    "extract(s, pattern)",
    "Извлекает первое совпадение с регулярным выражением.",
  ],
  [
    "JSONExtract",
    "JSONExtract(json, ..., return_type)",
    "Извлекает из JSON значение указанного типа.",
  ],
  [
    "JSONExtractString",
    "JSONExtractString(json, ...)",
    "Извлекает строку из JSON.",
  ],
  [
    "JSONExtractInt",
    "JSONExtractInt(json, ...)",
    "Извлекает целое число из JSON.",
  ],
  [
    "JSONExtractArrayRaw",
    "JSONExtractArrayRaw(json, ...)",
    "Извлекает JSON-массив как массив строк с исходными элементами.",
  ],
  ["tuple", "tuple(x, ...)", "Создаёт кортеж."],
  [
    "tupleElement",
    "tupleElement(tuple, index_or_name)",
    "Возвращает поле кортежа.",
  ],
  ["map", "map(key, value, ...)", "Создаёт отображение ключей в значения."],
  ["mapKeys", "mapKeys(map)", "Возвращает ключи отображения массивом."],
  ["mapValues", "mapValues(map)", "Возвращает значения отображения массивом."],
  [
    "round",
    "round(x[, decimals])",
    "Округляет число до указанной десятичной точности.",
  ],
  ["intDiv", "intDiv(x, y)", "Делит целые числа с округлением вниз."],
  [
    "cityHash64",
    "cityHash64(value, ...)",
    "Вычисляет 64-битный некриптографический хеш.",
  ],
  ["sipHash64", "sipHash64(value, ...)", "Вычисляет 64-битный SipHash."],
];
const aggregateDefinitions: [string, string, string][] = [
  [
    "count",
    "count([x])",
    "Считает строки или значения выражения, не равные NULL.",
  ],
  ["sum", "sum(x)", "Вычисляет сумму значений."],
  [
    "sumWithOverflow",
    "sumWithOverflow(x)",
    "Суммирует в исходном типе с возможным переполнением.",
  ],
  ["avg", "avg(x)", "Вычисляет среднее арифметическое."],
  ["min", "min(x)", "Возвращает минимальное значение."],
  ["max", "max(x)", "Возвращает максимальное значение."],
  [
    "any",
    "any(x)",
    "Возвращает одно из встреченных значений; выбор недетерминирован.",
  ],
  [
    "anyLast",
    "anyLast(x)",
    "Возвращает последнее встреченное значение; порядок недетерминирован.",
  ],
  [
    "anyHeavy",
    "anyHeavy(x)",
    "Находит часто встречающееся значение алгоритмом тяжёлых элементов.",
  ],
  [
    "uniq",
    "uniq(x, ...)",
    "Приближённо считает уникальные значения адаптивной выборкой.",
  ],
  [
    "uniqExact",
    "uniqExact(x, ...)",
    "Точно считает уникальные значения; память растёт с их числом.",
  ],
  [
    "uniqCombined",
    "uniqCombined([precision])(x, ...)",
    "Приближённо считает уникальные значения комбинированным алгоритмом.",
  ],
  [
    "uniqCombined64",
    "uniqCombined64([precision])(x, ...)",
    "Приближённо считает уникальные значения с 64-битными хешами.",
  ],
  [
    "uniqHLL12",
    "uniqHLL12(x, ...)",
    "Приближённо считает уникальные значения алгоритмом HyperLogLog.",
  ],
  [
    "uniqTheta",
    "uniqTheta(x, ...)",
    "Приближённо считает уникальные значения с помощью Theta-скетчей.",
  ],
  [
    "argMin",
    "argMin(arg, val)",
    "Возвращает аргумент, соответствующий минимальному значению.",
  ],
  [
    "argMax",
    "argMax(arg, val)",
    "Возвращает аргумент, соответствующий максимальному значению.",
  ],
  [
    "groupArray",
    "groupArray([max_size])(x)",
    "Собирает значения в массив с неопределённым порядком.",
  ],
  [
    "groupUniqArray",
    "groupUniqArray([max_size])(x)",
    "Собирает уникальные значения в массив.",
  ],
  [
    "groupArrayArray",
    "groupArrayArray(arr)",
    "Объединяет входные массивы из разных строк.",
  ],
  [
    "groupArrayInsertAt",
    "groupArrayInsertAt([default[, size]])(value, position)",
    "Собирает значения в массив на указанных позициях.",
  ],
  [
    "groupConcat",
    "groupConcat([delimiter[, limit]])(x)",
    "Соединяет строки из нескольких строк результата.",
  ],
  [
    "quantile",
    "quantile(level)(x)",
    "Приближённо вычисляет квантиль резервуарной выборкой.",
  ],
  [
    "quantiles",
    "quantiles(level1, ...)(x)",
    "Приближённо вычисляет несколько квантилей в одном состоянии.",
  ],
  ["quantileExact", "quantileExact(level)(x)", "Точно вычисляет квантиль."],
  [
    "quantileTDigest",
    "quantileTDigest(level)(x)",
    "Приближённо вычисляет квантиль с помощью t-digest.",
  ],
  [
    "median",
    "median(x)",
    "Приближённо вычисляет медиану; синоним quantile уровня 0.5.",
  ],
  ["topK", "topK(k)(x)", "Приближённо возвращает наиболее частые значения."],
  [
    "topKWeighted",
    "topKWeighted(k)(x, weight)",
    "Приближённо возвращает наиболее частые значения с учётом весов.",
  ],
  [
    "groupBitmap",
    "groupBitmap(x)",
    "Считает мощность битовой карты беззнаковых целых.",
  ],
  [
    "stddevPop",
    "stddevPop(x)",
    "Вычисляет стандартное отклонение генеральной совокупности.",
  ],
  [
    "stddevSamp",
    "stddevSamp(x)",
    "Вычисляет выборочное стандартное отклонение.",
  ],
  ["varPop", "varPop(x)", "Вычисляет дисперсию генеральной совокупности."],
  ["varSamp", "varSamp(x)", "Вычисляет выборочную дисперсию."],
  ["corr", "corr(x, y)", "Вычисляет коэффициент корреляции Пирсона."],
  [
    "covarPop",
    "covarPop(x, y)",
    "Вычисляет ковариацию генеральной совокупности.",
  ],
];

const builtinFunctions: SqlFunction[] = [
  ...scalarDefinitions.map(([name, syntax, description]) => ({
    name,
    syntax,
    description,
    isAggregate: false,
  })),
  ...aggregateDefinitions.map(([name, syntax, description]) => ({
    name,
    syntax,
    description,
    isAggregate: true,
  })),
];
const builtinByName = new Map(
  builtinFunctions.map((fn) => [fn.name.toLowerCase(), fn]),
);
const combinatorDescriptions: Record<string, string> = {
  If: "Учитывает только строки, для которых последнее условие истинно.",
  Array: "Агрегирует элементы массивов, переданных аргументами.",
  ForEach: "Агрегирует каждую позицию массивов отдельно.",
  Map: "Агрегирует значения отображения отдельно для каждого ключа.",
  Distinct: "Агрегирует уникальные сочетания аргументов.",
  State: "Возвращает промежуточное состояние AggregateFunction.",
  Merge: "Объединяет состояния агрегатной функции и возвращает итог.",
  SimpleState:
    "Возвращает SimpleAggregateFunction; доступно только для поддерживаемых функций.",
  OrDefault:
    "Возвращает значение типа по умолчанию, если нет значений для агрегации.",
  OrNull: "Возвращает NULL, если нет значений для агрегации.",
  Resample:
    "Агрегирует по интервалам: nameResample(start, end, step)(value, key).",
  ArgMin: "Учитывает только строки с минимальным дополнительным аргументом.",
  ArgMax: "Учитывает только строки с максимальным дополнительным аргументом.",
};
// Deliberately bounded canonical combinations, not arbitrary permutations.
// Array precedes If; State follows argument/condition adapters; MergeState uses both.
const suffixPatterns = [
  ["If"],
  ["Array"],
  ["Array", "If"],
  ["ForEach"],
  ["Map"],
  ["Distinct"],
  ["Distinct", "If"],
  ["OrDefault"],
  ["OrDefault", "If"],
  ["OrNull"],
  ["OrNull", "If"],
  ["State"],
  ["If", "State"],
  ["Array", "State"],
  ["Array", "If", "State"],
  ["Merge"],
  ["Merge", "State"],
  ["SimpleState"],
  ["Resample"],
  ["ArgMin"],
  ["ArgMax"],
];
const simpleStateFunctions = new Set([
  "any",
  "anyLast",
  "min",
  "max",
  "sum",
  "sumWithOverflow",
  "groupArrayArray",
  "groupUniqArrayArray",
  "groupBitAnd",
  "groupBitOr",
  "groupBitXor",
  "minMap",
  "maxMap",
  "sumMap",
]);
// These are reported as aggregates by system.functions but need OVER and cannot
// accept ordinary aggregate combinators.
const windowOnly = new Set(
  [
    "rank",
    "denseRank",
    "dense_rank",
    "percentRank",
    "percent_rank",
    "row_number",
    "rowNumber",
    "ntile",
    "lag",
    "lead",
    "lagInFrame",
    "leadInFrame",
    "first_value",
    "last_value",
    "nth_value",
    "nonNegativeDerivative",
  ].map((name) => name.toLowerCase()),
);

function functionSuggestion(fn: SqlFunction): SqlSuggestion {
  const fallback = builtinByName.get(fn.name.toLowerCase());
  return {
    label: fn.name,
    insertText: fn.name,
    kind: "function",
    detail: fn.isAggregate
      ? "Агрегатная функция ClickHouse"
      : "Функция ClickHouse",
    documentation:
      [fn.syntax || fallback?.syntax, fn.description || fallback?.description]
        .filter(Boolean)
        .join("\n\n") || fn.name,
  };
}

export function clickhouseFunctionSuggestions(
  prefix: string,
  catalog?: SqlFunctionCatalog,
): SqlSuggestion[] {
  const functions = catalog?.functions ?? builtinFunctions;
  const suggestions = new Map(
    functions.map((fn) => [fn.name, functionSuggestion(fn)]),
  );
  const available = new Set(
    catalog?.aggregateCombinators ?? Object.keys(combinatorDescriptions),
  );
  const typed = prefix.toLowerCase();
  let generated = 0;
  for (const fn of functions) {
    if (
      !fn.isAggregate ||
      windowOnly.has(fn.name.toLowerCase()) ||
      !typed ||
      !typed.startsWith(fn.name.toLowerCase())
    )
      continue;
    for (const suffixes of suffixPatterns) {
      if (!suffixes.every((suffix) => available.has(suffix))) continue;
      if (
        suffixes.includes("SimpleState") &&
        !simpleStateFunctions.has(fn.name)
      )
        continue;
      const name = fn.name + suffixes.join("");
      if (!name.toLowerCase().startsWith(typed) || suggestions.has(name))
        continue;
      suggestions.set(name, {
        label: name,
        insertText: name,
        kind: "function",
        detail: `Агрегатная функция ClickHouse · ${suffixes.join(" + ")}`,
        documentation: [
          `${name} — ${fn.name} с комбинаторами ${suffixes.join(" + ")}.`,
          ...suffixes.map((suffix) => combinatorDescriptions[suffix]),
        ].join("\n\n"),
      });
      if (++generated >= 120) return [...suggestions.values()];
    }
  }
  return [...suggestions.values()];
}

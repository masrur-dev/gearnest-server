export function parsePositiveInteger(
  value,
  {
    name,
    defaultValue,
    maximum = Number.MAX_SAFE_INTEGER,
    clamp = false,
  }
) {
  if (value === undefined || value === "") {
    return { value: defaultValue };
  }

  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value)
  ) {
    return {
      error: `${name} must be a positive integer`,
    };
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      error: `${name} must be a positive integer`,
    };
  }

  if (parsed > maximum && !clamp) {
    return {
      error: `${name} must not exceed ${maximum}`,
    };
  }

  return {
    value: clamp ? Math.min(parsed, maximum) : parsed,
  };
}

export function parsePagination(
  query,
  { defaultLimit, maxLimit }
) {
  const page = parsePositiveInteger(query.page, {
    name: "page",
    defaultValue: 1,
  });

  if (page.error) {
    return page;
  }

  const limit = parsePositiveInteger(query.limit, {
    name: "limit",
    defaultValue: defaultLimit,
    maximum: maxLimit,
    clamp: true,
  });

  if (limit.error) {
    return limit;
  }

  if (
    page.value >
    Math.floor(Number.MAX_SAFE_INTEGER / limit.value)
  ) {
    return { error: "page is too large" };
  }

  return {
    value: {
      page: page.value,
      limit: limit.value,
    },
  };
}

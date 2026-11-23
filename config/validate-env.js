function isSet(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      ["http:", "https:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isMongoUri(value) {
  try {
    const url = new URL(value);

    return (
      ["mongodb:", "mongodb+srv:"].includes(url.protocol) &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function validateUrl(env, name, errors) {
  const value = env[name];

  if (isSet(value) && !isHttpUrl(value)) {
    errors.push(`${name} must be an absolute HTTP(S) URL`);
  }
}

export function validateEnvironment(env = process.env) {
  const errors = [];
  const mongoUri = env.MONGODB_URI;
  const authSecret = env.BETTER_AUTH_SECRET;

  if (!isSet(mongoUri)) {
    errors.push("MONGODB_URI is required");
  } else if (!isMongoUri(mongoUri)) {
    errors.push("MONGODB_URI must be a valid MongoDB URI");
  }

  if (!isSet(authSecret)) {
    errors.push("BETTER_AUTH_SECRET is required");
  } else if (Buffer.byteLength(authSecret, "utf8") < 32) {
    errors.push("BETTER_AUTH_SECRET must be at least 32 bytes");
  }

  validateUrl(env, "BETTER_AUTH_URL", errors);
  validateUrl(env, "CLIENT_URL", errors);

  for (const provider of ["GOOGLE", "GITHUB"]) {
    const idName = `${provider}_CLIENT_ID`;
    const secretName = `${provider}_CLIENT_SECRET`;
    const id = env[idName];
    const secret = env[secretName];
    const idSet = isSet(id);
    const secretSet = isSet(secret);

    if (
      (id !== undefined && !idSet) ||
      (secret !== undefined && !secretSet)
    ) {
      errors.push(`${idName} and ${secretName} cannot be blank`);
    }

    if (idSet !== secretSet) {
      errors.push(
        `${idName} and ${secretName} must be set together`
      );
    }
  }

  if (env.PORT !== undefined && env.PORT !== "") {
    const port = Number(env.PORT);

    if (
      !/^\d+$/.test(env.PORT) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      errors.push("PORT must be an integer from 1 to 65535");
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${errors.join("; ")}`
    );
  }

  return true;
}

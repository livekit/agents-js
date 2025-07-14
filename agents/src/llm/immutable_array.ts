const READONLY_SYMBOL = Symbol('Readonly');

const MUTATION_METHODS = [
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
] as const;

export function createImmutableArray<T>(array: T[], additionalErrorMessage: string = ''): T[] {
  return new Proxy(array, {
    get(target, key) {
      if (key === READONLY_SYMBOL) {
        return true;
      }

      // Intercept mutation methods
      if (typeof key === 'string' && MUTATION_METHODS.includes(key as any)) {
        return function () {
          throw new TypeError(
            `Cannot call ${key}() on a read-only array. ${additionalErrorMessage}`.trim(),
          );
        };
      }

      return Reflect.get(target, key);
    },
    // block any property writes
    set(_, prop) {
      throw new TypeError(
        `Cannot assign to read-only array index "${String(prop)}". ${additionalErrorMessage}`.trim(),
      );
    },
    // block deletions
    deleteProperty(_, prop) {
      throw new TypeError(
        `Cannot delete read-only array index "${String(prop)}". ${additionalErrorMessage}`.trim(),
      );
    },
    // block adding or modifying property descriptors
    defineProperty(_, prop) {
      throw new TypeError(
        `Cannot define property "${String(prop)}" on a read-only array. ${additionalErrorMessage}`.trim(),
      );
    },
    // block changing the prototype
    setPrototypeOf() {
      throw new TypeError(
        `Cannot change prototype of a read-only array. ${additionalErrorMessage}`.trim(),
      );
    },
  });
}

export function isImmutableArray(array: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof array === 'object' && !!(array as any)[READONLY_SYMBOL];
}

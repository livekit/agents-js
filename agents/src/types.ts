export const NOT_GIVEN = Symbol('NOT_GIVEN');

export type NotGiven = typeof NOT_GIVEN;

export type NotGivenOr<T> = T | NotGiven;

export function isGiven<T>(obj: NotGivenOr<T>): obj is T {
  return obj !== NOT_GIVEN;
}

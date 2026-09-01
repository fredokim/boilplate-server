import type { ValidationError } from 'class-validator';
import { flattenValidationErrors } from './validationException';

function error(partial: Partial<ValidationError>): ValidationError {
  return { property: '', children: [], ...partial } as ValidationError;
}

describe('flattenValidationErrors', () => {
  it('maps a top-level field to its messages', () => {
    const fields = flattenValidationErrors([
      error({ property: 'email', constraints: { isEmail: 'email must be an email' } }),
    ]);

    expect(fields).toEqual({ email: ['email must be an email'] });
  });

  it('keeps every constraint on a field rather than the first', () => {
    const fields = flattenValidationErrors([
      error({
        property: 'password',
        constraints: { minLength: 'password is too short', matches: 'password needs a digit' },
      }),
    ]);

    expect(fields.password).toEqual(['password is too short', 'password needs a digit']);
  });

  it('joins nested objects with a dot path', () => {
    const fields = flattenValidationErrors([
      error({
        property: 'profile',
        children: [error({ property: 'displayName', constraints: { isString: 'displayName must be a string' } })],
      }),
    ]);

    expect(fields).toEqual({ 'profile.displayName': ['displayName must be a string'] });
  });

  it('renders array indices in bracket form so the path matches the form field', () => {
    const fields = flattenValidationErrors([
      error({
        property: 'nodes',
        children: [
          error({
            property: '0',
            children: [error({ property: 'id', constraints: { isNotEmpty: 'id should not be empty' } })],
          }),
        ],
      }),
    ]);

    expect(fields).toEqual({ 'nodes[0].id': ['id should not be empty'] });
  });

  it('carries a parent constraint and its children at the same time', () => {
    const fields = flattenValidationErrors([
      error({
        property: 'profile',
        constraints: { isObject: 'profile must be an object' },
        children: [error({ property: 'age', constraints: { isInt: 'age must be an integer' } })],
      }),
    ]);

    expect(fields).toEqual({
      profile: ['profile must be an object'],
      'profile.age': ['age must be an integer'],
    });
  });

  it('returns an empty map for no errors', () => {
    expect(flattenValidationErrors([])).toEqual({});
  });
});

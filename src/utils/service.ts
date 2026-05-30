export type Result<T, E = Error> =
	| { ok: true; value: T; error: null }
	| { ok: false; value: null; error: E };

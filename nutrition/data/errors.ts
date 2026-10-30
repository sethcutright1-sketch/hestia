// The one error type the nutrition data layer throws on purpose.
//
// It carries an HTTP-style status so the routes (routes/nutrition/) answer with it directly
// (`res.status(err.status).json({ error: err.message, ...err.extra })`) and the assistant's
// tools can show err.message to the model. Anything that is NOT a NutritionError is a bug and
// should surface as a 500, which is why the data layer never throws plain Errors for bad input.

export class NutritionError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "NutritionError";
  }
}

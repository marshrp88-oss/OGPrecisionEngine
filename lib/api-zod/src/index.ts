// Re-export the orval-generated zod schemas. Each schema is a runtime const;
// consumers can derive its TypeScript shape via `z.infer<typeof X>` when needed.
//
// We deliberately do NOT re-export `./generated/types` here: orval generates
// identical names in both files (e.g. `CreateBillBody` exists as a zod schema
// in `./generated/api` and as a bare TS interface in `./generated/types`), and
// barrel-re-exporting both produces dozens of TS2308 ambiguity errors. No
// consumer in this repo imports the bare interface form — every usage is a
// zod schema parse — so dropping the duplicate barrel is safe and removes
// ~30 type errors at the package boundary.
export * from "./generated/api";

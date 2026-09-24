import { describe, expect, it } from "vitest";
import {
  OrganizationError,
  assertValidSlug,
  resolveOrganizationSlug,
  sanitizeOrganizationName,
  slugify,
} from "./slug.js";

describe("sanitizeOrganizationName", () => {
  it("recorta espacios y colapsa espacios internos", () => {
    expect(sanitizeOrganizationName("  Acme   del   Oeste  ")).toBe("Acme del Oeste");
  });

  it("rechaza nombres vacíos o solo espacios", () => {
    expect(() => sanitizeOrganizationName("")).toThrow(OrganizationError);
    expect(() => sanitizeOrganizationName("   ")).toThrow(OrganizationError);
  });

  it("rechaza nombres de más de 255 caracteres", () => {
    expect(() => sanitizeOrganizationName("a".repeat(256))).toThrow(OrganizationError);
    expect(sanitizeOrganizationName("a".repeat(255))).toHaveLength(255);
  });

  it("no restringe el juego de caracteres (es texto libre para mostrar)", () => {
    expect(sanitizeOrganizationName("Acme 🚗 Motors — S.A.")).toBe("Acme 🚗 Motors — S.A.");
  });
});

describe("slugify", () => {
  it("deriva un slug simple a partir de un nombre", () => {
    expect(slugify("Acme Motors")).toBe("acme-motors");
  });

  it("quita tildes/diacríticos en vez de descartar las letras", () => {
    expect(slugify("Acme del Oeste")).toBe("acme-del-oeste");
    expect(slugify("Organización")).toBe("organizacion");
    expect(slugify("Peña & Asociados")).toBe("pena-asociados");
  });

  it("colapsa símbolos y espacios consecutivos en un solo guion", () => {
    expect(slugify("Acme   Motors!!!")).toBe("acme-motors");
  });

  it("nunca deja guiones al inicio o al final", () => {
    expect(slugify("--Acme Motors--")).toBe("acme-motors");
  });

  it("devuelve string vacío si no hay nada slugificable", () => {
    expect(slugify("🚗🚗🚗")).toBe("");
  });

  it("trunca a 63 caracteres sin dejar un guion colgando al final", () => {
    const long = "a ".repeat(100).trim();
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("assertValidSlug", () => {
  it("acepta un slug bien formado", () => {
    expect(assertValidSlug("acme-motors")).toBe("acme-motors");
    expect(assertValidSlug("acme123")).toBe("acme123");
  });

  it("rechaza mayúsculas, espacios, símbolos y guiones dobles/borde", () => {
    for (const bad of ["Acme-Motors", "acme motors", "acme_motors", "-acme", "acme-", "acme--motors", ""]) {
      expect(() => assertValidSlug(bad)).toThrow(OrganizationError);
    }
  });

  it("rechaza slugs de más de 63 caracteres", () => {
    expect(() => assertValidSlug("a".repeat(64))).toThrow(OrganizationError);
  });
});

describe("resolveOrganizationSlug", () => {
  it("deriva el slug del nombre cuando no se pasa uno explícito", () => {
    expect(resolveOrganizationSlug("Acme Motors")).toBe("acme-motors");
  });

  it("valida (no deriva) el slug explícito, aunque no coincida con el nombre", () => {
    expect(resolveOrganizationSlug("Acme Motors", "custom-handle")).toBe("custom-handle");
  });

  it("rechaza un slug explícito mal formado", () => {
    expect(() => resolveOrganizationSlug("Acme Motors", "Not A Slug")).toThrow(OrganizationError);
  });

  it("rechaza cuando el nombre no produce ningún slug derivable", () => {
    expect(() => resolveOrganizationSlug("🚗🚗🚗")).toThrow(OrganizationError);
  });
});

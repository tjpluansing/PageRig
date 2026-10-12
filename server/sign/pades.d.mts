// Types for pades.mjs, which the app imports too.

export interface Signer {
  name: string;
  email: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  selfSigned: boolean;
}

/** A certificate and its private key, read from a .p12 / .pfx file. */
export interface SigningIdentity extends Signer {
  key: unknown;
  cert: unknown;
  chain: unknown[];
}

export interface SignOptions {
  reason?: string;
  location?: string;
  contact?: string;
  date?: Date;
  /** Draw a signature box at the bottom right of this page (0-based; -1 for the last). */
  visible?: { page: number } | null;
  fieldName?: string;
}

export interface SignatureCheck {
  name: string;
  email: string;
  issuer: string;
  selfSigned: boolean;
  signedAt: Date | null;
  reason: string;
  /** The signature matches the signed bytes and the signer's certificate. */
  valid: boolean;
  /** Nothing was added to the file after this signature. */
  coversWholeFile: boolean;
  problem: string | null;
}

export function readP12(bytes: Uint8Array, password: string): SigningIdentity;
export function selfSignedP12(options: { name: string; email?: string; password?: string; years?: number; bits?: number }): Uint8Array;
export function signPdf(bytes: Uint8Array, signer: SigningIdentity, options?: SignOptions): Promise<Uint8Array>;
export function checkSignatures(bytes: Uint8Array): Promise<SignatureCheck[]>;

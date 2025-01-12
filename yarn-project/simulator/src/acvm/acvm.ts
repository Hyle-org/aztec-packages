import { type NoirCallStack, type SourceCodeLocation } from '@aztec/circuit-types';
import { type Fr } from '@aztec/circuits.js';
import type { BrilligFunctionId, FunctionAbi, FunctionDebugMetadata, OpcodeLocation } from '@aztec/foundation/abi';
import { createDebugLogger } from '@aztec/foundation/log';

import {
  type ExecutionError,
  type ForeignCallInput,
  type ForeignCallOutput,
  type RawAssertionPayload,
  executeCircuitWithReturnWitness,
} from '@noir-lang/acvm_js';
import { abiDecodeError } from '@noir-lang/noirc_abi';

import { traverseCauseChain } from '../common/errors.js';
import { type ACVMWitness } from './acvm_types.js';
import { type ORACLE_NAMES } from './oracle/index.js';

/**
 * The callback interface for the ACIR.
 */
type ACIRCallback = Record<
  ORACLE_NAMES,
  (...args: ForeignCallInput[]) => void | Promise<void> | ForeignCallOutput | Promise<ForeignCallOutput>
>;

/**
 * The result of executing an ACIR.
 */
export interface ACIRExecutionResult {
  /**
   * An execution result contains two witnesses.
   * 1. The partial witness of the execution.
   * 2. The return witness which contains the given public return values within the full witness.
   */
  partialWitness: ACVMWitness;
  returnWitness: ACVMWitness;
}

/**
 * Extracts a brillig location from an opcode location.
 * @param opcodeLocation - The opcode location to extract from. It should be in the format `acirLocation.brilligLocation` or `acirLocation`.
 * @returns The brillig location if the opcode location contains one.
 */
function extractBrilligLocation(opcodeLocation: string): string | undefined {
  const splitted = opcodeLocation.split('.');
  if (splitted.length === 2) {
    return splitted[1];
  }
  return undefined;
}

/**
 * Extracts the call stack from the location of a failing opcode and the debug metadata.
 * One opcode can point to multiple calls due to inlining.
 */
function getSourceCodeLocationsFromOpcodeLocation(
  opcodeLocation: string,
  debug: FunctionDebugMetadata,
  brilligFunctionId?: BrilligFunctionId,
): SourceCodeLocation[] {
  const { debugSymbols, files } = debug;

  let callStack = debugSymbols.locations[opcodeLocation] || [];
  if (callStack.length === 0) {
    const brilligLocation = extractBrilligLocation(opcodeLocation);
    if (brilligFunctionId !== undefined && brilligLocation !== undefined) {
      callStack = debugSymbols.brillig_locations[brilligFunctionId][brilligLocation] || [];
    }
  }
  return callStack.map(call => {
    const { file: fileId, span } = call;

    const { path, source } = files[fileId];

    const locationText = source.substring(span.start, span.end);
    const precedingText = source.substring(0, span.start);
    const previousLines = precedingText.split('\n');
    // Lines and columns in stacks are one indexed.
    const line = previousLines.length;
    const column = previousLines[previousLines.length - 1].length + 1;

    return {
      filePath: path,
      line,
      column,
      fileSource: source,
      locationText,
    };
  });
}

/**
 * Extracts the source code locations for an array of opcode locations
 * @param opcodeLocations - The opcode locations that caused the error.
 * @param debug - The debug metadata of the function.
 * @returns The source code locations.
 */
export function resolveOpcodeLocations(
  opcodeLocations: OpcodeLocation[],
  debug: FunctionDebugMetadata,
  brilligFunctionId?: BrilligFunctionId,
): SourceCodeLocation[] {
  return opcodeLocations.flatMap(opcodeLocation =>
    getSourceCodeLocationsFromOpcodeLocation(opcodeLocation, debug, brilligFunctionId),
  );
}

export function resolveAssertionMessage(errorPayload: RawAssertionPayload, abi: FunctionAbi): string | undefined {
  const decoded = abiDecodeError(
    { parameters: [], error_types: abi.errorTypes, return_type: null }, // eslint-disable-line camelcase
    errorPayload,
  );

  if (typeof decoded === 'string') {
    return decoded;
  } else {
    return JSON.stringify(decoded);
  }
}

export function resolveAssertionMessageFromRevertData(revertData: Fr[], abi: FunctionAbi): string | undefined {
  if (revertData.length == 0) {
    return undefined;
  }

  const [errorSelector, ...errorData] = revertData;

  return resolveAssertionMessage(
    {
      selector: errorSelector.toBigInt().toString(),
      data: errorData.map(f => f.toString()),
    },
    abi,
  );
}

export function resolveAssertionMessageFromError(err: Error, abi: FunctionAbi): string {
  if (typeof err === 'object' && err !== null && 'rawAssertionPayload' in err && err.rawAssertionPayload) {
    return `Assertion failed: ${resolveAssertionMessage(err.rawAssertionPayload as RawAssertionPayload, abi)}`;
  } else {
    return err.message;
  }
}

/**
 * The function call that executes an ACIR.
 */
export async function acvm(
  acir: Buffer,
  initialWitness: ACVMWitness,
  callback: ACIRCallback,
): Promise<ACIRExecutionResult> {
  const logger = createDebugLogger('aztec:simulator:acvm');

  const solvedAndReturnWitness = await executeCircuitWithReturnWitness(
    acir,
    initialWitness,
    async (name: string, args: ForeignCallInput[]) => {
      try {
        logger.debug(`Oracle callback ${name}`);
        const oracleFunction = callback[name as ORACLE_NAMES];
        if (!oracleFunction) {
          throw new Error(`Oracle callback ${name} not found`);
        }

        const result = await oracleFunction.call(callback, ...args);
        return typeof result === 'undefined' ? [] : [result];
      } catch (err) {
        let typedError: Error;
        if (err instanceof Error) {
          typedError = err;
        } else {
          typedError = new Error(`Error in oracle callback ${err}`);
        }
        logger.error(`Error in oracle callback ${name}: ${typedError.message}`);
        throw typedError;
      }
    },
  ).catch((err: Error) => {
    // Wasm callbacks act as a boundary for stack traces, so we capture it here and complete the error if it happens.
    const stack = new Error().stack;

    traverseCauseChain(err, cause => {
      if (cause.stack) {
        cause.stack += stack;
      }
    });

    throw err;
  });

  return { partialWitness: solvedAndReturnWitness.solvedWitness, returnWitness: solvedAndReturnWitness.returnWitness };
}

/**
 * Extracts the call stack from an thrown by the acvm.
 * @param error - The error to extract from.
 * @param debug - The debug metadata of the function called.
 * @returns The call stack, if available.
 */
export function extractCallStack(
  error: Error | ExecutionError,
  debug?: FunctionDebugMetadata,
): NoirCallStack | undefined {
  if (!('callStack' in error) || !error.callStack) {
    return undefined;
  }
  const { callStack, brilligFunctionId } = error;
  if (!debug) {
    return callStack;
  }

  try {
    return resolveOpcodeLocations(callStack, debug, brilligFunctionId);
  } catch (err) {
    return callStack;
  }
}

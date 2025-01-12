import {
  NestedProcessReturnValues,
  type PublicExecutionRequest,
  type SimulationError,
  type UnencryptedFunctionL2Logs,
} from '@aztec/circuit-types';
import {
  type AvmExecutionHints,
  type ContractStorageRead,
  type ContractStorageUpdateRequest,
  type Fr,
  Gas,
  type L2ToL1Message,
  type LogHash,
  type NoteHash,
  type Nullifier,
  PublicCallStackItemCompressed,
  PublicInnerCallRequest,
  type ReadRequest,
  RevertCode,
  type TreeLeafReadRequest,
} from '@aztec/circuits.js';
import { computeVarArgsHash } from '@aztec/circuits.js/hash';

/**
 * The public function execution result.
 */
export interface PublicExecutionResult {
  /** The execution request that triggered this result. */
  executionRequest: PublicExecutionRequest;

  /** The side effect counter at the start of the function call. */
  startSideEffectCounter: Fr;
  /** The side effect counter after executing this function call */
  endSideEffectCounter: Fr;
  /** How much gas was available for this public execution. */
  startGasLeft: Gas;
  /** How much gas was left after this public execution. */
  endGasLeft: Gas;
  /** Transaction fee set for this tx. */
  transactionFee: Fr;

  /** Bytecode used for this execution. */
  bytecode?: Buffer;
  /** Calldata used for this execution. */
  calldata: Fr[];
  /** The return values of the function. */
  returnValues: Fr[];
  /** Whether the execution reverted. */
  reverted: boolean;
  /** The revert reason if the execution reverted. */
  revertReason?: SimulationError;

  /** The contract storage reads performed by the function. */
  contractStorageReads: ContractStorageRead[];
  /** The contract storage update requests performed by the function. */
  contractStorageUpdateRequests: ContractStorageUpdateRequest[];
  /** The new note hashes to be inserted into the note hashes tree. */
  noteHashes: NoteHash[];
  /** The new l2 to l1 messages generated in this call. */
  l2ToL1Messages: L2ToL1Message[];
  /** The new nullifiers to be inserted into the nullifier tree. */
  nullifiers: Nullifier[];
  /** The note hash read requests emitted in this call. */
  noteHashReadRequests: TreeLeafReadRequest[];
  /** The nullifier read requests emitted in this call. */
  nullifierReadRequests: ReadRequest[];
  /** The nullifier non existent read requests emitted in this call. */
  nullifierNonExistentReadRequests: ReadRequest[];
  /** L1 to L2 message read requests emitted in this call. */
  l1ToL2MsgReadRequests: TreeLeafReadRequest[];
  /**
   * The hashed logs with side effect counter.
   * Note: required as we don't track the counter anywhere else.
   */
  unencryptedLogsHashes: LogHash[];
  /**
   * Unencrypted logs emitted during execution of this function call.
   * Note: These are preimages to `unencryptedLogsHashes`.
   */
  unencryptedLogs: UnencryptedFunctionL2Logs;
  /**
   * Unencrypted logs emitted during this call AND any nested calls.
   * Useful for maintaining correct ordering in ts.
   */
  allUnencryptedLogs: UnencryptedFunctionL2Logs;

  /** The requests to call public functions made by this call. */
  publicCallRequests: PublicInnerCallRequest[];
  /** The results of nested calls. */
  nestedExecutions: this[];

  /** Hints for proving AVM execution. */
  avmCircuitHints: AvmExecutionHints;

  /** The name of the function that was executed. Only used for logging. */
  functionName: string;
}

/**
 * Recursively accummulate the return values of a call result and its nested executions,
 * so they can be retrieved in order.
 * @param executionResult
 * @returns
 */
export function accumulatePublicReturnValues(executionResult: PublicExecutionResult): NestedProcessReturnValues {
  const acc = new NestedProcessReturnValues(executionResult.returnValues);
  acc.nested = executionResult.nestedExecutions.map(nestedExecution => accumulatePublicReturnValues(nestedExecution));
  return acc;
}

export function collectExecutionResults(result: PublicExecutionResult): PublicExecutionResult[] {
  return [result, ...result.nestedExecutions.map(collectExecutionResults)].flat();
}

/**
 * Checks whether the child execution result is valid for a static call (no state modifications).
 * @param executionResult - The execution result of a public function
 */

export function checkValidStaticCall(
  noteHashes: NoteHash[],
  nullifiers: Nullifier[],
  contractStorageUpdateRequests: ContractStorageUpdateRequest[],
  l2ToL1Messages: L2ToL1Message[],
  unencryptedLogs: UnencryptedFunctionL2Logs,
) {
  if (
    contractStorageUpdateRequests.length > 0 ||
    noteHashes.length > 0 ||
    nullifiers.length > 0 ||
    l2ToL1Messages.length > 0 ||
    unencryptedLogs.logs.length > 0
  ) {
    throw new Error('Static call cannot update the state, emit L2->L1 messages or generate logs');
  }
}

export function resultToPublicCallRequest(result: PublicExecutionResult) {
  const request = result.executionRequest;
  const item = new PublicCallStackItemCompressed(
    request.callContext.contractAddress,
    request.callContext,
    computeVarArgsHash(request.args),
    computeVarArgsHash(result.returnValues),
    // TODO(@just-mitch): need better mapping from simulator to revert code.
    result.reverted ? RevertCode.APP_LOGIC_REVERTED : RevertCode.OK,
    Gas.from(result.startGasLeft),
    Gas.from(result.endGasLeft),
  );
  return new PublicInnerCallRequest(item, result.startSideEffectCounter.toNumber());
}

import type { AvmContext } from '../avm_context.js';
import { type Field, type MemoryValue } from '../avm_memory_types.js';
import { Opcode } from '../serialization/instruction_serialization.js';
import { Addressing } from './addressing_mode.js';
import { ThreeOperandInstruction } from './instruction_impl.js';

export abstract class ThreeOperandArithmeticInstruction extends ThreeOperandInstruction {
  public async execute(context: AvmContext): Promise<void> {
    const memory = context.machineState.memory.track(this.type);
    context.machineState.consumeGas(this.gasCost());

    const operands = [this.aOffset, this.bOffset, this.dstOffset];
    const addressing = Addressing.fromWire(this.indirect, operands.length);
    const [aOffset, bOffset, dstOffset] = addressing.resolve(operands, memory);
    memory.checkTagsAreSame(aOffset, bOffset);

    const a = memory.get(aOffset);
    const b = memory.get(bOffset);

    const dest = this.compute(a, b);
    memory.set(dstOffset, dest);

    memory.assert({ reads: 2, writes: 1, addressing });
  }

  protected abstract compute(a: MemoryValue, b: MemoryValue): MemoryValue;
}

export class Add extends ThreeOperandArithmeticInstruction {
  static readonly type: string = 'ADD';
  static readonly opcode = Opcode.ADD_8; // FIXME: needed for gas.

  protected compute(a: MemoryValue, b: MemoryValue): MemoryValue {
    return a.add(b);
  }
}

export class Sub extends ThreeOperandArithmeticInstruction {
  static readonly type: string = 'SUB';
  static readonly opcode = Opcode.SUB_8; // FIXME: needed for gas.

  protected compute(a: MemoryValue, b: MemoryValue): MemoryValue {
    return a.sub(b);
  }
}

export class Mul extends ThreeOperandArithmeticInstruction {
  static type: string = 'MUL';
  static readonly opcode = Opcode.MUL_8; // FIXME: needed for gas.

  protected compute(a: MemoryValue, b: MemoryValue): MemoryValue {
    return a.mul(b);
  }
}

export class Div extends ThreeOperandArithmeticInstruction {
  static type: string = 'DIV';
  static readonly opcode = Opcode.DIV_8; // FIXME: needed for gas.

  protected compute(a: MemoryValue, b: MemoryValue): MemoryValue {
    return a.div(b);
  }
}

// TODO: This class now temporarily has a tag, until all tags are removed.
export class FieldDiv extends ThreeOperandArithmeticInstruction {
  static type: string = 'FDIV';
  static readonly opcode = Opcode.FDIV_8; // FIXME: needed for gas.

  protected compute(a: Field, b: Field): Field {
    // return (a as Field).fdiv(b as Field);
    return a.fdiv(b);
  }
}

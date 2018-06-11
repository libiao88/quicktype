import { Value, Tag, valueTag, CompressedJSON } from "./CompressedJSON";
import { assertNever } from "../support/Support";
import { TypeBuilder } from "../TypeBuilder";
import { UnionBuilder, UnionAccumulator } from "../UnionBuilder";
import { isTime, isDateTime, isDate } from "../DateTime";
import { ClassProperty } from "../Type";
import { TypeAttributes, emptyTypeAttributes } from "../TypeAttributes";
import { StringTypes } from "../StringTypes";
import { TypeRef } from "../TypeGraph";

// This should be the recursive type
//   Value[] | NestedValueArray[]
// but TypeScript doesn't support that.
export type NestedValueArray = any;

function forEachArrayInNestedValueArray(va: NestedValueArray, f: (va: Value[]) => void): void {
    if (va.length === 0) {
        return;
    }
    if (Array.isArray(va[0])) {
        for (const x of va) {
            forEachArrayInNestedValueArray(x, f);
        }
    } else {
        f(va);
    }
}

function forEachValueInNestedValueArray(va: NestedValueArray, f: (v: Value) => void): void {
    forEachArrayInNestedValueArray(va, a => {
        for (const x of a) {
            f(x);
        }
    });
}

class InferenceUnionBuilder extends UnionBuilder<TypeBuilder, NestedValueArray, NestedValueArray> {
    constructor(
        typeBuilder: TypeBuilder,
        private readonly _typeInference: TypeInference,
        private readonly _fixed: boolean
    ) {
        super(typeBuilder);
    }

    protected makeObject(
        objects: NestedValueArray,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined
    ): TypeRef {
        return this._typeInference.inferClassType(typeAttributes, objects, this._fixed, forwardingRef);
    }

    protected makeArray(
        arrays: NestedValueArray,
        _typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined
    ): TypeRef {
        return this.typeBuilder.getArrayType(
            this._typeInference.inferType(emptyTypeAttributes, arrays, this._fixed, forwardingRef)
        );
    }
}

function canBeEnumCase(s: string): boolean {
    if (s.length === 0) return true; // FIXME: Do we really want this?
    return !isDate(s) && !isTime(s) && !isDateTime(s);
}

export type Accumulator = UnionAccumulator<NestedValueArray, NestedValueArray>;

export class TypeInference {
    constructor(
        private readonly _cjson: CompressedJSON,
        private readonly _typeBuilder: TypeBuilder,
        private readonly _inferMaps: boolean,
        private readonly _inferEnums: boolean,
        private readonly _inferDates: boolean
    ) {}

    addValuesToAccumulator(valueArray: NestedValueArray, accumulator: Accumulator): void {
        forEachValueInNestedValueArray(valueArray, value => {
            const t = valueTag(value);
            switch (t) {
                case Tag.Null:
                    accumulator.addPrimitive("null", emptyTypeAttributes);
                    break;
                case Tag.False:
                case Tag.True:
                    accumulator.addPrimitive("bool", emptyTypeAttributes);
                    break;
                case Tag.Integer:
                    accumulator.addPrimitive("integer", emptyTypeAttributes);
                    break;
                case Tag.Double:
                    accumulator.addPrimitive("double", emptyTypeAttributes);
                    break;
                case Tag.InternedString:
                    if (this._inferEnums) {
                        const s = this._cjson.getStringForValue(value);
                        if (canBeEnumCase(s)) {
                            accumulator.addStringCase(s, 1, emptyTypeAttributes);
                        } else {
                            accumulator.addStringType("string", emptyTypeAttributes);
                        }
                    } else {
                        accumulator.addStringType("string", emptyTypeAttributes);
                    }
                    break;
                case Tag.UninternedString:
                    accumulator.addStringType("string", emptyTypeAttributes);
                    break;
                case Tag.Object:
                    accumulator.addObject(this._cjson.getObjectForValue(value), emptyTypeAttributes);
                    break;
                case Tag.Array:
                    accumulator.addArray(this._cjson.getArrayForValue(value), emptyTypeAttributes);
                    break;
                case Tag.Date:
                    accumulator.addStringType(
                        "string",
                        emptyTypeAttributes,
                        this._inferDates ? StringTypes.date : StringTypes.unrestricted
                    );
                    break;
                case Tag.Time:
                    accumulator.addStringType(
                        "string",
                        emptyTypeAttributes,
                        this._inferDates ? StringTypes.time : StringTypes.unrestricted
                    );
                    break;
                case Tag.DateTime:
                    accumulator.addStringType(
                        "string",
                        emptyTypeAttributes,
                        this._inferDates ? StringTypes.dateTime : StringTypes.unrestricted
                    );
                    break;
                default:
                    return assertNever(t);
            }
        });
    }

    inferType(
        typeAttributes: TypeAttributes,
        valueArray: NestedValueArray,
        fixed: boolean,
        forwardingRef?: TypeRef
    ): TypeRef {
        const accumulator = this.accumulatorForArray(valueArray);
        return this.makeTypeFromAccumulator(accumulator, typeAttributes, fixed, forwardingRef);
    }

    accumulatorForArray(valueArray: NestedValueArray): Accumulator {
        const accumulator = new UnionAccumulator<NestedValueArray, NestedValueArray>(true);
        this.addValuesToAccumulator(valueArray, accumulator);
        return accumulator;
    }

    makeTypeFromAccumulator(
        accumulator: Accumulator,
        typeAttributes: TypeAttributes,
        fixed: boolean,
        forwardingRef?: TypeRef
    ): TypeRef {
        const unionBuilder = new InferenceUnionBuilder(this._typeBuilder, this, fixed);
        return unionBuilder.buildUnion(accumulator, false, typeAttributes, forwardingRef);
    }

    inferClassType(
        typeAttributes: TypeAttributes,
        objects: NestedValueArray,
        fixed: boolean,
        forwardingRef?: TypeRef
    ): TypeRef {
        const propertyNames: string[] = [];
        const propertyValues: { [name: string]: Value[] } = {};

        forEachArrayInNestedValueArray(objects, arr => {
            for (let i = 0; i < arr.length; i += 2) {
                const key = this._cjson.getStringForValue(arr[i]);
                const value = arr[i + 1];
                if (!Object.prototype.hasOwnProperty.call(propertyValues, key)) {
                    propertyNames.push(key);
                    propertyValues[key] = [];
                }
                propertyValues[key].push(value);
            }
        });

        if (this._inferMaps && propertyNames.length > 500) {
            const accumulator = new UnionAccumulator<NestedValueArray, NestedValueArray>(true);
            for (const key of propertyNames) {
                this.addValuesToAccumulator(propertyValues[key], accumulator);
            }
            const values = this.makeTypeFromAccumulator(accumulator, emptyTypeAttributes, fixed);
            return this._typeBuilder.getMapType(typeAttributes, values, forwardingRef);
        }

        const properties = new Map<string, ClassProperty>();
        for (const key of propertyNames) {
            const values = propertyValues[key];
            const t = this.inferType(emptyTypeAttributes, values, false);
            const isOptional = values.length < objects.length;
            properties.set(key, this._typeBuilder.makeClassProperty(t, isOptional));
        }

        if (fixed) {
            return this._typeBuilder.getUniqueClassType(typeAttributes, true, properties, forwardingRef);
        } else {
            return this._typeBuilder.getClassType(typeAttributes, properties, forwardingRef);
        }
    }
}

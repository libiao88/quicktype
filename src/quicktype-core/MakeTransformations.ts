import { setFilter, setUnion, iterableFirst, mapMapEntries } from "collection-utils";

import { TypeGraph, TypeRef, typeRefIndex } from "./TypeGraph";
import { TargetLanguage } from "./TargetLanguage";
import { UnionType, TypeKind, EnumType, Type, PrimitiveType } from "./Type";
import { GraphRewriteBuilder } from "./GraphRewriting";
import { defined, assert, panic } from "./support/Support";
import {
    UnionInstantiationTransformer,
    DecodingChoiceTransformer,
    Transformation,
    transformationTypeAttributeKind,
    StringMatchTransformer,
    StringProducerTransformer,
    ChoiceTransformer,
    Transformer,
    DecodingTransformer,
    ParseDateTimeTransformer,
    ParseIntegerTransformer
} from "./Transformers";
import { TypeAttributes, emptyTypeAttributes } from "./TypeAttributes";
import { StringTypes } from "./StringTypes";
import { RunContext } from "./Run";

function transformationAttributes(
    graph: TypeGraph,
    reconstitutedTargetType: TypeRef,
    transformer: Transformer,
    debugPrintTransformations: boolean
): TypeAttributes {
    const transformation = new Transformation(graph, reconstitutedTargetType, transformer);
    if (debugPrintTransformations) {
        console.log(`transformation for ${typeRefIndex(reconstitutedTargetType)}:`);
        transformation.debugPrint();
    }
    return transformationTypeAttributeKind.makeAttributes(transformation);
}

function makeEnumTransformer(
    graph: TypeGraph,
    enumType: EnumType,
    stringType: TypeRef,
    continuation?: Transformer
): Transformer {
    const sortedCases = Array.from(enumType.cases).sort();
    const caseTransformers = sortedCases.map(
        c =>
            new StringMatchTransformer(
                graph,
                stringType,
                new StringProducerTransformer(graph, stringType, continuation, c),
                c
            )
    );
    return new ChoiceTransformer(graph, stringType, caseTransformers);
}

function replaceUnion(
    union: UnionType,
    builder: GraphRewriteBuilder<Type>,
    forwardingRef: TypeRef,
    debugPrintTransformations: boolean
): TypeRef {
    const graph = builder.typeGraph;

    assert(union.members.size > 0, "We can't have empty unions");

    const integerMember = union.findMember("integer");

    function reconstituteMember(t: Type): TypeRef {
        // Special handling for integer-string: The type in the union must
        // be "integer", so if one already exists, use that one, otherwise
        // make a new one.
        if (t.kind === "integer-string") {
            if (integerMember !== undefined) {
                return builder.reconstituteType(integerMember);
            }
            return builder.getPrimitiveType("integer");
        }
        return builder.reconstituteType(t);
    }

    const reconstitutedMembersByKind = mapMapEntries(union.members.entries(), m => [m.kind, reconstituteMember(m)]);
    const reconstitutedUnion = builder.getUnionType(
        union.getAttributes(),
        new Set(reconstitutedMembersByKind.values())
    );

    function memberForKind(kind: TypeKind) {
        return defined(reconstitutedMembersByKind.get(kind));
    }

    function transformerForKind(kind: TypeKind) {
        const member = union.findMember(kind);
        if (member === undefined) return undefined;
        const memberTypeRef = memberForKind(kind);
        return new DecodingTransformer(graph, memberTypeRef, new UnionInstantiationTransformer(graph, memberTypeRef));
    }

    let maybeStringType: TypeRef | undefined = undefined;
    function getStringType(): TypeRef {
        if (maybeStringType === undefined) {
            maybeStringType = builder.getStringType(emptyTypeAttributes, StringTypes.unrestricted);
        }
        return maybeStringType;
    }

    function transformerForStringType(t: Type): Transformer {
        const memberRef = memberForKind(t.kind);
        switch (t.kind) {
            case "string":
                return defined(transformerForKind(t.kind));

            case "date-time":
                return new ParseDateTimeTransformer(
                    graph,
                    getStringType(),
                    new UnionInstantiationTransformer(graph, memberRef)
                );

            case "enum": {
                const enumType = t as EnumType;
                return makeEnumTransformer(
                    graph,
                    enumType,
                    getStringType(),
                    new UnionInstantiationTransformer(graph, memberRef)
                );
            }

            case "integer-string":
                return new ParseIntegerTransformer(
                    graph,
                    getStringType(),
                    new UnionInstantiationTransformer(graph, memberRef)
                );

            default:
                return panic(`Can't transform string type ${t.kind}`);
        }
    }

    const stringTypes = union.stringTypeMembers;
    let transformerForString: Transformer | undefined;
    if (stringTypes.size === 0) {
        transformerForString = undefined;
    } else if (stringTypes.size === 1) {
        const t = defined(iterableFirst(stringTypes));
        const memberTypeRef = memberForKind(t.kind);
        transformerForString = new DecodingTransformer(
            graph,
            memberTypeRef,
            new UnionInstantiationTransformer(graph, memberTypeRef)
        );
    } else {
        transformerForString = new DecodingTransformer(
            graph,
            getStringType(),
            new ChoiceTransformer(graph, getStringType(), Array.from(stringTypes).map(transformerForStringType))
        );
    }

    const transformerForClass = transformerForKind("class");
    const transformerForMap = transformerForKind("map");
    assert(
        transformerForClass === undefined || transformerForMap === undefined,
        "Can't have both class and map in a transformed union"
    );
    const transformerForObject = transformerForClass !== undefined ? transformerForClass : transformerForMap;

    const transformer = new DecodingChoiceTransformer(
        graph,
        builder.getPrimitiveType("any"),
        transformerForKind("null"),
        transformerForKind("integer"),
        transformerForKind("double"),
        transformerForKind("bool"),
        transformerForString,
        transformerForKind("array"),
        transformerForObject
    );
    const attributes = transformationAttributes(graph, reconstitutedUnion, transformer, debugPrintTransformations);
    return builder.getPrimitiveType("any", attributes, forwardingRef);
}

function replaceEnum(
    enumType: EnumType,
    builder: GraphRewriteBuilder<Type>,
    forwardingRef: TypeRef,
    debugPrintTransformations: boolean
): TypeRef {
    const stringType = builder.getStringType(emptyTypeAttributes, StringTypes.unrestricted);
    const transformer = new DecodingTransformer(
        builder.typeGraph,
        stringType,
        makeEnumTransformer(builder.typeGraph, enumType, stringType)
    );
    const reconstitutedEnum = builder.getEnumType(enumType.getAttributes(), enumType.cases);
    const attributes = transformationAttributes(
        builder.typeGraph,
        reconstitutedEnum,
        transformer,
        debugPrintTransformations
    );
    return builder.getStringType(attributes, StringTypes.unrestricted, forwardingRef);
}

function replaceIntegerString(
    t: PrimitiveType,
    builder: GraphRewriteBuilder<Type>,
    forwardingRef: TypeRef,
    debugPrintTransformations: boolean
): TypeRef {
    const stringType = builder.getStringType(emptyTypeAttributes, StringTypes.unrestricted);
    const transformer = new DecodingTransformer(
        builder.typeGraph,
        stringType,
        new ParseIntegerTransformer(builder.typeGraph, stringType, undefined)
    );
    const attributes = transformationAttributes(
        builder.typeGraph,
        builder.getPrimitiveType("integer", builder.reconstituteTypeAttributes(t.getAttributes())),
        transformer,
        debugPrintTransformations
    );
    return builder.getStringType(attributes, StringTypes.unrestricted, forwardingRef);
}

export function makeTransformations(ctx: RunContext, graph: TypeGraph, targetLanguage: TargetLanguage): TypeGraph {
    function replace(
        setOfOneUnion: ReadonlySet<Type>,
        builder: GraphRewriteBuilder<Type>,
        forwardingRef: TypeRef
    ): TypeRef {
        const t = defined(iterableFirst(setOfOneUnion));
        if (t instanceof UnionType) {
            return replaceUnion(t, builder, forwardingRef, ctx.debugPrintTransformations);
        }
        if (t instanceof EnumType) {
            return replaceEnum(t, builder, forwardingRef, ctx.debugPrintTransformations);
        }
        if (t instanceof PrimitiveType && t.kind === "integer-string") {
            return replaceIntegerString(t, builder, forwardingRef, ctx.debugPrintReconstitution);
        }
        return panic(`Cannot make transformation for type ${t.kind}`);
    }

    const allTypesUnordered = graph.allTypesUnordered();
    const unions = setFilter(
        allTypesUnordered,
        t => t instanceof UnionType && targetLanguage.needsTransformerForUnion(t)
    );
    const enums = targetLanguage.needsTransformerForEnums
        ? setFilter(allTypesUnordered, t => t instanceof EnumType)
        : new Set();
    const integerStrings = setFilter(allTypesUnordered, t => t.kind === "integer-string");
    const groups = Array.from(setUnion(unions, enums, integerStrings)).map(t => [t]);
    return graph.rewrite(
        "make-transformations",
        ctx.stringTypeMapping,
        false,
        groups,
        ctx.debugPrintReconstitution,
        replace
    );
}

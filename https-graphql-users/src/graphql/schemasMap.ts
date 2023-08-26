import 'graphql-import-node';
import * as userTypeDefs from "allotr-graphql-schema-types/src/schemas/user.graphql"
import { DIRECTIVES } from '@graphql-codegen/typescript-mongodb';
import { GraphQLSchema } from "graphql";
import { makeExecutableSchema } from '@graphql-tools/schema'
import { stitchingDirectives } from '@graphql-tools/stitching-directives'
import { mergeResolvers } from "@graphql-tools/merge";
import { UserResolvers } from './resolvers/UserResolvers';

const { allStitchingDirectivesTypeDefs, stitchingDirectivesValidator } = stitchingDirectives()

const typeDefs = /* GraphQL */ `
  ${allStitchingDirectivesTypeDefs}
  ${DIRECTIVES?.loc?.source?.body}
  ${userTypeDefs?.loc?.source?.body}
`
const resolvers = mergeResolvers([UserResolvers, {
    Query: {
        // 2. Setup a query that exposes the raw SDL...
        _sdlUser: () => typeDefs,
    },
}]);

const schema: GraphQLSchema = makeExecutableSchema({
    typeDefs,
    resolvers
});

// 3. Include the stitching directives validator...
export default stitchingDirectivesValidator(schema);

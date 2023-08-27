import { getMongoDBConnection } from "./src/utils/mongodb-connector";
import { getRedisConnection } from "./src/utils/redis-connector";
import schema from "./src/graphql/schemasMap";
import { getLoadedEnvVariables } from "./src/utils/env-loader";
import { createYoga } from "graphql-yoga";
import { TemplatedApp } from "uWebSockets.js";
import { useGraphQlJit } from '@envelop/graphql-jit'
import { useParserCache } from "@envelop/parser-cache";

import { UseResponseCacheParameter, useResponseCache } from '@graphql-yoga/plugin-response-cache'
import { createRedisCache } from '@envelop/response-cache-redis'
import { getUserInfoFromRequest, initializeSessionStore, logoutSession } from "./src/middlewares/auth";
import { corsRequestHandler } from "./src/middlewares/cors";
import { ServerContext, UserContext } from "./src/types/yoga-context";
import { initializeWebPush } from "./src/notifications/web-push";
import _ from "lodash";
import { queryNames } from "./src/consts/query-names";



function onServerCreated(app: TemplatedApp) {
  // Create GraphQL HTTP server
  // IMPORTANT: ENVIRONMENT VARIABLES ONLY ARE AVAILABLE HERE AND ON onServerListen
  initializeWebPush();
  const redis = getRedisConnection().connection;
  const cache = createRedisCache({ redis }) as UseResponseCacheParameter["cache"]
  initializeSessionStore();

  const yoga = createYoga<ServerContext, UserContext>({
    schema,
    context: async ({ req, res, request, params }) => {
      // Context factory gets called for every request
      const [sid, userId] = await getUserInfoFromRequest(request, params);
      return {
        req,
        res,
        user: {
          _id: userId! // After login the user id is not null
        },
        mongoDBConnection: getMongoDBConnection(),
        redisConnection: getRedisConnection(),
        sid: sid!, // After login the session id is not null
        logout: logoutSession,
        cache
      }
    },
    cors: corsRequestHandler,
    graphiql: true,
    plugins: [
      useGraphQlJit(),
      useParserCache(),
      useResponseCache({
        idFields: ["id", "_id"],
        // cache based on the authorization header
        session: request => {
          return request.headers.get('authorization')
        },
        shouldCacheResult: ({ result }) => {
          const functionBlacklist = [
            // Add functions to blacklist
          ]

          const data = result?.data as any;
          const isEmptyValue = queryNames.some(query => data?.[query] != null && _.isEmpty(data?.[query]))
          const isValidFunction = functionBlacklist.every(key => data?.[key] == null);

          return !isEmptyValue && isValidFunction
        },
        cache
      })
    ]
  })
  app.any("/graphql", yoga);
}

async function onServerListen(app: TemplatedApp) {
  // MongoDB Connection
  const { HTTPS_PORT } = getLoadedEnvVariables();

  console.log(`GraphQL server running on port ${HTTPS_PORT}`);
}


export { onServerCreated, onServerListen };

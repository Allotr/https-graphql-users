
import { LocalRole, OperationResult, Resolvers, ResourceDbObject, ResourceNotificationDbObject, TicketStatusCode, User, UserDbObject, UserDeletionResult } from "allotr-graphql-schema-types";
import { ReadConcern, ReadPreference, TransactionOptions, WriteConcern } from "mongodb"
import { NOTIFICATIONS, RESOURCES, USERS } from "../consts/collections";
import { clearOutQueueDependantTickets, removeUsersInQueue } from "../utils/resolver-utils";
import { GraphQLContext } from "../types/yoga-context";
import { GraphQLError } from "graphql";
import { getTargetUserId } from "../guards/guards";
import { logoutByUserId } from "../middlewares/auth";
import { lockCacheWrite, unlockCacheWrite } from "../cache/lock";


export const UserResolvers: Resolvers = {
  Query: {
    currentUser: async (parent, args, context: GraphQLContext) => {
      const { userId: targetUserId } = args;
      const userId = getTargetUserId(context.user, targetUserId);

      const db = await (await context.mongoDBConnection).db;
      const user = await db.collection<UserDbObject>(USERS).findOne({ _id: userId });
      
      if (user == null) {
        throw new GraphQLError("Cannot read user")
      }
      return user! as User;
    },
    searchUsers: async (parent, args, context: GraphQLContext) => {
      const db = await (await context.mongoDBConnection).db;

      const usersFound = await db.collection<UserDbObject>(USERS).find(
        {
          $text: { $search: args.query ?? "" }
        }, {
        projection: {
          _id: 1, username: 1, name: 1, surname: 1
        }
      }).sort({
        name: 1
      }).toArray();

      const userData = usersFound.map(({ _id, username = "", name = "", surname = "" }) => ({
        id: _id?.toHexString()!,
        username,
        name,
        surname
      }));

      return userData;
    }
  },
  Mutation: {
    deleteUser: async (parent, args, context: GraphQLContext) => {
      const timestamp = new Date();
      const { deleteAllFlag, userId: targetUserId } = args;
      const userId = getTargetUserId(context.user, targetUserId);
      const userIdString = userId.toHexString();

      const db = await (await context.mongoDBConnection).db;

      const client = await (await context.mongoDBConnection).connection;

      let result: UserDeletionResult = { status: OperationResult.Ok };


      // We must liberate all resources that lock the queue for other users
      // This code is not inside this operation session because it has its own session
      const userResourceList = await db.collection<ResourceDbObject>(RESOURCES).find({
        "tickets.user._id": userId
      }).sort({
        creationDate: 1
      }).toArray();

      for (const resource of userResourceList) {
        try {
          await clearOutQueueDependantTickets(resource, [{ id: userIdString, role: LocalRole.ResourceUser }], context, TicketStatusCode.AwaitingConfirmation, db);
          await clearOutQueueDependantTickets(resource, [{ id: userIdString, role: LocalRole.ResourceUser }], context, TicketStatusCode.Active, db);
          await removeUsersInQueue(resource, [{ id: userIdString, role: LocalRole.ResourceUser }], timestamp, db, context);
        } catch (e) {
          console.log("Some queue dependant resource could not be cleared out");
        }
      }

      // Step 1: Start a Client Session
      const session = client.startSession();
      // Step 2: Optional. Define options to use for the transaction
      const transactionOptions: TransactionOptions = {
        readPreference: new ReadPreference(ReadPreference.PRIMARY),
        readConcern: new ReadConcern("local"),
        writeConcern: new WriteConcern("majority")
      };
      // Step 3: Use withTransaction to start a transaction, execute the callback, and commit (or abort on error)
      // Note: The callback for withTransaction MUST be async and/or return a Promise.
      try {
        await session.withTransaction(async () => {
          // Delete tickets
          await db.collection<ResourceDbObject>(RESOURCES).updateMany({
            "tickets.user._id": userId,
          }, {
            $pull: {
              tickets: {
                "user._id": userId
              }
            } as any
          }, {
            session
          })
          // Delete resources
          await db.collection<ResourceDbObject>(RESOURCES).deleteMany(
            {
              "createdBy._id": userId,
              ...(!deleteAllFlag && {
                $and: [{
                  "tickets.user.role": LocalRole.ResourceUser
                },
                { "tickets.user._id": { $ne: userId } }]
              })
            }, {
            session
          })

          // Delete notifications
          await db.collection<ResourceNotificationDbObject>(NOTIFICATIONS).deleteMany({
            "user._id": userId
          }, { session })

          // Delete user
          await db.collection<UserDbObject>(USERS).deleteOne({ _id: userId }, { session })

          if (result == null) {
            return { status: OperationResult.Error, newObjectId: null };
          }
        }, transactionOptions);
      } finally {
        await lockCacheWrite();
        await context?.cache?.invalidate([
          {
            typename: "User"
          },
          {
            typename: "PublicUser"
          },
          {
            typename: "ResourceCard"
          },
          {
            typename: "ResourceView"
          }
        ])
        await unlockCacheWrite();
        await session.endSession();
      }
      if (result.status === OperationResult.Error) {
        return result;
      }




      // Close session before it's too late!
      await logoutByUserId(userId);

      return { status: OperationResult.Ok }
    }
  }
}




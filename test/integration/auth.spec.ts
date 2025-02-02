/*!
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as admin from '../../lib/index';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import * as scrypt from 'scrypt';
import firebase from '@firebase/app';
import '@firebase/auth';
import {clone} from 'lodash';
import {
  generateRandomString, projectId, apiKey, noServiceAccountApp, cmdArgs,
} from './setup';
import url = require('url');
import * as mocks from '../resources/mocks';
import { AuthProviderConfig } from '../../src/auth/auth-config';
import { deepExtend, deepCopy } from '../../src/utils/deep-copy';

/* tslint:disable:no-var-requires */
const chalk = require('chalk');
/* tslint:enable:no-var-requires */

chai.should();
chai.use(chaiAsPromised);

const expect = chai.expect;

const newUserUid = generateRandomString(20);
const nonexistentUid = generateRandomString(20);
const sessionCookieUids = [
  generateRandomString(20),
  generateRandomString(20),
  generateRandomString(20),
];
const testPhoneNumber = '+11234567890';
const testPhoneNumber2 = '+16505550101';
const nonexistentPhoneNumber = '+18888888888';
const updatedEmail = generateRandomString(20).toLowerCase() + '@example.com';
const updatedPhone = '+16505550102';
const customClaims: {[key: string]: any} = {
  admin: true,
  groupId: '1234',
};
const uids = [newUserUid + '-1', newUserUid + '-2', newUserUid + '-3'];
const mockUserData = {
  email: newUserUid.toLowerCase() + '@example.com',
  emailVerified: false,
  phoneNumber: testPhoneNumber,
  password: 'password',
  displayName: 'Random User ' + newUserUid,
  photoURL: 'http://www.example.com/' + newUserUid + '/photo.png',
  disabled: false,
};
const actionCodeSettings = {
  url: 'http://localhost/?a=1&b=2#c=3',
  handleCodeInApp: false,
};
let deleteQueue = Promise.resolve();

interface UserImportTest {
  name: string;
  importOptions: admin.auth.UserImportOptions;
  rawPassword: string;
  rawSalt?: string;
  computePasswordHash(userImportTest: UserImportTest): Buffer;
}


describe('admin.auth', () => {

  let uidFromCreateUserWithoutUid: string;

  before(() => {
    firebase.initializeApp({
      apiKey,
      authDomain: projectId + '.firebaseapp.com',
    });
    return cleanup();
  });

  after(() => {
    return cleanup();
  });

  it('createUser() creates a new user when called without a UID', () => {
    const newUserData = clone(mockUserData);
    newUserData.email = generateRandomString(20).toLowerCase() + '@example.com';
    newUserData.phoneNumber = testPhoneNumber2;
    return admin.auth().createUser(newUserData)
      .then((userRecord) => {
        uidFromCreateUserWithoutUid = userRecord.uid;
        expect(typeof userRecord.uid).to.equal('string');
        // Confirm expected email.
        expect(userRecord.email).to.equal(newUserData.email);
        // Confirm expected phone number.
        expect(userRecord.phoneNumber).to.equal(newUserData.phoneNumber);
      });
  });

  it('createUser() creates a new user with the specified UID', () => {
    const newUserData: any = clone(mockUserData);
    newUserData.uid = newUserUid;
    return admin.auth().createUser(newUserData)
      .then((userRecord) => {
        expect(userRecord.uid).to.equal(newUserUid);
        // Confirm expected email.
        expect(userRecord.email).to.equal(newUserData.email);
        // Confirm expected phone number.
        expect(userRecord.phoneNumber).to.equal(newUserData.phoneNumber);
      });
  });

  it('createUser() fails when the UID is already in use', () => {
    const newUserData: any = clone(mockUserData);
    newUserData.uid = newUserUid;
    return admin.auth().createUser(newUserData)
      .should.eventually.be.rejected.and.have.property('code', 'auth/uid-already-exists');
  });

  it('getUser() returns a user record with the matching UID', () => {
    return admin.auth().getUser(newUserUid)
      .then((userRecord) => {
        expect(userRecord.uid).to.equal(newUserUid);
      });
  });

  it('getUserByEmail() returns a user record with the matching email', () => {
    return admin.auth().getUserByEmail(mockUserData.email)
      .then((userRecord) => {
        expect(userRecord.uid).to.equal(newUserUid);
      });
  });

  it('getUserByPhoneNumber() returns a user record with the matching phone number', () => {
    return admin.auth().getUserByPhoneNumber(mockUserData.phoneNumber)
      .then((userRecord) => {
        expect(userRecord.uid).to.equal(newUserUid);
      });
  });

  it('listUsers() returns up to the specified number of users', () => {
    const promises: Array<Promise<admin.auth.UserRecord>> = [];
    uids.forEach((uid) => {
      const tempUserData = {
        uid,
        password: 'password',
      };
      promises.push(admin.auth().createUser(tempUserData));
    });
    return Promise.all(promises)
      .then(() => {
        // Return 2 users with the provided page token.
        // This test will fail if other users are created in between.
        return admin.auth().listUsers(2, uids[0]);
      })
      .then((listUsersResult) => {
        // Confirm expected number of users.
        expect(listUsersResult.users.length).to.equal(2);
        // Confirm next page token present.
        expect(typeof listUsersResult.pageToken).to.equal('string');
        // Confirm each user's uid and the hashed passwords.
        expect(listUsersResult.users[0].uid).to.equal(uids[1]);
        expect(listUsersResult.users[0].passwordHash.length).greaterThan(0);
        expect(listUsersResult.users[0].passwordSalt.length).greaterThan(0);

        expect(listUsersResult.users[1].uid).to.equal(uids[2]);
        expect(listUsersResult.users[1].passwordHash.length).greaterThan(0);
        expect(listUsersResult.users[1].passwordSalt.length).greaterThan(0);
      });
  });

  it('revokeRefreshTokens() invalidates existing sessions and ID tokens', () => {
    let currentIdToken: string = null;
    let currentUser: any = null;
    // Sign in with an email and password account.
    return firebase.auth().signInWithEmailAndPassword(mockUserData.email, mockUserData.password)
      .then(({user}) => {
        currentUser = user;
        // Get user's ID token.
        return user.getIdToken();
      })
      .then((idToken) => {
        currentIdToken = idToken;
        // Verify that user's ID token while checking for revocation.
        return admin.auth().verifyIdToken(currentIdToken, true);
      })
      .then((decodedIdToken) => {
        // Verification should succeed. Revoke that user's session.
        return new Promise((resolve) => setTimeout(() => resolve(
          admin.auth().revokeRefreshTokens(decodedIdToken.sub),
        ), 1000));
      })
      .then(() => {
        // verifyIdToken without checking revocation should still succeed.
        return admin.auth().verifyIdToken(currentIdToken)
          .should.eventually.be.fulfilled;
      })
      .then(() => {
        // verifyIdToken while checking for revocation should fail.
        return admin.auth().verifyIdToken(currentIdToken, true)
          .should.eventually.be.rejected.and.have.property('code', 'auth/id-token-revoked');
      })
      .then(() => {
        // Confirm token revoked on client.
        return currentUser.reload()
          .should.eventually.be.rejected.and.have.property('code', 'auth/user-token-expired');
      })
      .then(() => {
        // New sign-in should succeed.
        return firebase.auth().signInWithEmailAndPassword(
            mockUserData.email, mockUserData.password);
      })
      .then(({user}) => {
        // Get new session's ID token.
        return user.getIdToken();
      })
      .then((idToken) => {
        // ID token for new session should be valid even with revocation check.
        return admin.auth().verifyIdToken(idToken, true)
          .should.eventually.be.fulfilled;
      });
  });

  it('setCustomUserClaims() sets claims that are accessible via user\'s ID token', () => {
    // Set custom claims on the user.
    return admin.auth().setCustomUserClaims(newUserUid, customClaims)
      .then(() => {
        return admin.auth().getUser(newUserUid);
      })
      .then((userRecord) => {
        // Confirm custom claims set on the UserRecord.
        expect(userRecord.customClaims).to.deep.equal(customClaims);
        return firebase.auth().signInWithEmailAndPassword(
          userRecord.email, mockUserData.password);
      })
      .then(({user}) => {
         // Get the user's ID token.
         return user.getIdToken();
      })
      .then((idToken) => {
         // Verify ID token contents.
         return admin.auth().verifyIdToken(idToken);
      })
      .then((decodedIdToken: {[key: string]: any}) => {
        // Confirm expected claims set on the user's ID token.
        for (const key in customClaims) {
          if (customClaims.hasOwnProperty(key)) {
            expect(decodedIdToken[key]).to.equal(customClaims[key]);
          }
        }
      });
  });

  it('updateUser() updates the user record with the given parameters', () => {
    const updatedDisplayName = 'Updated User ' + newUserUid;
    return admin.auth().updateUser(newUserUid, {
      email: updatedEmail,
      phoneNumber: updatedPhone,
      emailVerified: true,
      displayName: updatedDisplayName,
    })
      .then((userRecord) => {
        expect(userRecord.emailVerified).to.be.true;
        expect(userRecord.displayName).to.equal(updatedDisplayName);
        // Confirm expected email.
        expect(userRecord.email).to.equal(updatedEmail);
        // Confirm expected phone number.
        expect(userRecord.phoneNumber).to.equal(updatedPhone);
      });
  });

  it('getUser() fails when called with a non-existing UID', () => {
    return admin.auth().getUser(nonexistentUid)
      .should.eventually.be.rejected.and.have.property('code', 'auth/user-not-found');
  });

  it('getUserByEmail() fails when called with a non-existing email', () => {
    return admin.auth().getUserByEmail(nonexistentUid + '@example.com')
      .should.eventually.be.rejected.and.have.property('code', 'auth/user-not-found');
  });

  it('getUserByPhoneNumber() fails when called with a non-existing phone number', () => {
    return admin.auth().getUserByPhoneNumber(nonexistentPhoneNumber)
      .should.eventually.be.rejected.and.have.property('code', 'auth/user-not-found');
  });

  it('updateUser() fails when called with a non-existing UID', () => {
    return admin.auth().updateUser(nonexistentUid, {
      emailVerified: true,
    }).should.eventually.be.rejected.and.have.property('code', 'auth/user-not-found');
  });

  it('deleteUser() fails when called with a non-existing UID', () => {
    return admin.auth().deleteUser(nonexistentUid)
      .should.eventually.be.rejected.and.have.property('code', 'auth/user-not-found');
  });

  it('createCustomToken() mints a JWT that can be used to sign in', () => {
    return admin.auth().createCustomToken(newUserUid, {
      isAdmin: true,
    })
    .then((customToken) => {
      return firebase.auth().signInWithCustomToken(customToken);
    })
    .then(({user}) => {
      return user.getIdToken();
    })
    .then((idToken) => {
      return admin.auth().verifyIdToken(idToken);
    })
    .then((token) => {
      expect(token.uid).to.equal(newUserUid);
      expect(token.isAdmin).to.be.true;
    });
  });

  it('createCustomToken() can mint JWTs without a service account', () => {
    return admin.auth(noServiceAccountApp).createCustomToken(newUserUid, {
      isAdmin: true,
    })
    .then((customToken) => {
      return firebase.auth().signInWithCustomToken(customToken);
    })
    .then(({user}) => {
      return user.getIdToken();
    })
    .then((idToken) => {
      return admin.auth(noServiceAccountApp).verifyIdToken(idToken);
    })
    .then((token) => {
      expect(token.uid).to.equal(newUserUid);
      expect(token.isAdmin).to.be.true;
    });
  });

  it('verifyIdToken() fails when called with an invalid token', () => {
    return admin.auth().verifyIdToken('invalid-token')
      .should.eventually.be.rejected.and.have.property('code', 'auth/argument-error');
  });

  describe('Link operations', () => {
    const uid = generateRandomString(20).toLowerCase();
    const email = uid + '@example.com';
    const newPassword = 'newPassword';
    const userData = {
      uid,
      email,
      emailVerified: false,
      password: 'password',
    };

    // Create the test user before running this suite of tests.
    before(() => {
      return admin.auth().createUser(userData);
    });

    // Sign out after each test.
    afterEach(() => {
      return firebase.auth().signOut();
    });

    // Delete test user at the end of test suite.
    after(() => {
      return safeDelete(uid);
    });

    it('generatePasswordResetLink() should return a password reset link', () => {
      // Ensure old password set on created user.
      return admin.auth().updateUser(uid, {password: 'password'})
        .then((userRecord) => {
          return admin.auth().generatePasswordResetLink(email, actionCodeSettings);
        })
        .then((link) => {
          const code = getActionCode(link);
          expect(getContinueUrl(link)).equal(actionCodeSettings.url);
          return firebase.auth().confirmPasswordReset(code, newPassword);
        })
        .then(() => {
          return firebase.auth().signInWithEmailAndPassword(email, newPassword);
        })
        .then((result) => {
          expect(result.user.email).to.equal(email);
          // Password reset also verifies the user's email.
          expect(result.user.emailVerified).to.be.true;
        });
    });

    it('generateEmailVerificationLink() should return a verification link', () => {
      // Ensure the user's email is unverified.
      return admin.auth().updateUser(uid, {password: 'password', emailVerified: false})
        .then((userRecord) => {
          expect(userRecord.emailVerified).to.be.false;
          return admin.auth().generateEmailVerificationLink(email, actionCodeSettings);
        })
        .then((link) => {
          const code = getActionCode(link);
          expect(getContinueUrl(link)).equal(actionCodeSettings.url);
          return firebase.auth().applyActionCode(code);
        })
        .then(() => {
          return firebase.auth().signInWithEmailAndPassword(email, userData.password);
        })
        .then((result) => {
          expect(result.user.email).to.equal(email);
          expect(result.user.emailVerified).to.be.true;
        });
    });

    it('generateSignInWithEmailLink() should return a sign-in link', () => {
      return admin.auth().generateSignInWithEmailLink(email, actionCodeSettings)
        .then((link) => {
          expect(getContinueUrl(link)).equal(actionCodeSettings.url);
          return firebase.auth().signInWithEmailLink(email, link);
        })
        .then((result) => {
          expect(result.user.email).to.equal(email);
          expect(result.user.emailVerified).to.be.true;
        });
    });
  });

  describe('Tenant management operations', () => {
    let createdTenantId: string;
    const createdTenants: string[] = [];
    const tenantOptions: admin.auth.CreateTenantRequest = {
      displayName: 'testTenant1',
      emailSignInConfig: {
        enabled: true,
        passwordRequired: true,
      },
    };
    const expectedCreatedTenant: any = {
      displayName: 'testTenant1',
      emailSignInConfig: {
        enabled: true,
        passwordRequired: true,
      },
    };
    const expectedUpdatedTenant: any = {
      displayName: 'testTenantUpdated',
      emailSignInConfig: {
        enabled: false,
        passwordRequired: true,
      },
    };
    const expectedUpdatedTenant2: any = {
      displayName: 'testTenantUpdated',
      emailSignInConfig: {
        enabled: true,
        passwordRequired: false,
      },
    };

    // https://mochajs.org/
    // Passing arrow functions (aka "lambdas") to Mocha is discouraged.
    // Lambdas lexically bind this and cannot access the Mocha context.
    before(function() {
      /* tslint:disable:no-console */
      if (!cmdArgs.testMultiTenancy) {
        // To enable, run: npm run test:integration -- --testMultiTenancy
        // By default we skip multi-tenancy as it is a Google Cloud Identity Platform
        // feature only and requires to be enabled via the Cloud Console.
        console.log(chalk.yellow('    Skipping multi-tenancy tests.'));
        this.skip();
      }
      /* tslint:enable:no-console */
    });

    // Delete test tenants at the end of test suite.
    after(() => {
      const promises: Array<Promise<any>> = [];
      createdTenants.forEach((tenantId) => {
        promises.push(
            admin.auth().tenantManager().deleteTenant(tenantId)
                .catch((error) => {/** Ignore. */}));
      });
      return Promise.all(promises);
    });

    it('createTenant() should resolve with a new tenant', () => {
      return admin.auth().tenantManager().createTenant(tenantOptions)
        .then((actualTenant) => {
          createdTenantId = actualTenant.tenantId;
          createdTenants.push(createdTenantId);
          expectedCreatedTenant.tenantId = createdTenantId;
          expect(actualTenant.toJSON()).to.deep.equal(expectedCreatedTenant);
        });
    });

    // Sanity check user management + email link generation + custom attribute APIs.
    // TODO: Confirm behavior in client SDK when it starts supporting it.
    describe('supports user management, email link generation, custom attribute and token revocation APIs', () => {
      let tenantAwareAuth: admin.auth.TenantAwareAuth;
      let createdUserUid: string;
      let lastValidSinceTime: number;
      const newUserData = clone(mockUserData);
      newUserData.email = generateRandomString(20).toLowerCase() + '@example.com';
      newUserData.phoneNumber = testPhoneNumber;
      const importOptions: any = {
        hash: {
          algorithm: 'HMAC_SHA256',
          key: Buffer.from('secret'),
        },
      };
      const rawPassword = 'password';
      const rawSalt = 'NaCl';

      before(function() {
        if (!createdTenantId) {
          this.skip();
        } else {
          tenantAwareAuth = admin.auth().tenantManager().authForTenant(createdTenantId);
        }
      });

      // Delete test user at the end of test suite.
      after(() => {
        // If user successfully created, make sure it is deleted at the end of the test suite.
        if (createdUserUid) {
          return tenantAwareAuth.deleteUser(createdUserUid)
            .catch((error) => {
              // Ignore error.
            });
        }
      });

      it('createUser() should create a user in the expected tenant', () => {
        return tenantAwareAuth.createUser(newUserData)
          .then((userRecord) => {
            createdUserUid = userRecord.uid;
            expect(userRecord.tenantId).to.equal(createdTenantId);
            expect(userRecord.email).to.equal(newUserData.email);
            expect(userRecord.phoneNumber).to.equal(newUserData.phoneNumber);
          });
      });

      it('setCustomUserClaims() should set custom attributes on the tenant specific user', () => {
        return tenantAwareAuth.setCustomUserClaims(createdUserUid, customClaims)
          .then(() => {
            return tenantAwareAuth.getUser(createdUserUid);
          })
          .then((userRecord) => {
            expect(userRecord.uid).to.equal(createdUserUid);
            expect(userRecord.tenantId).to.equal(createdTenantId);
            // Confirm custom claims set on the UserRecord.
            expect(userRecord.customClaims).to.deep.equal(customClaims);
          });
      });

      it('updateUser() should update the tenant specific user', () => {
        return tenantAwareAuth.updateUser(createdUserUid, {
          email: updatedEmail,
          phoneNumber: updatedPhone,
        })
        .then((userRecord) => {
          expect(userRecord.uid).to.equal(createdUserUid);
          expect(userRecord.tenantId).to.equal(createdTenantId);
          expect(userRecord.email).to.equal(updatedEmail);
          expect(userRecord.phoneNumber).to.equal(updatedPhone);
        });
      });

      it('generateEmailVerificationLink() should generate the link for tenant specific user', () => {
        // Generate email verification link to confirm it is generated in the expected
        // tenant context.
        return tenantAwareAuth.generateEmailVerificationLink(updatedEmail, actionCodeSettings)
          .then((link) => {
            // Confirm tenant ID set in link.
            expect(getTenantId(link)).equal(createdTenantId);
          });
      });

      it('generatePasswordResetLink() should generate the link for tenant specific user', () => {
        // Generate password reset link to confirm it is generated in the expected
        // tenant context.
        return tenantAwareAuth.generatePasswordResetLink(updatedEmail, actionCodeSettings)
          .then((link) => {
            // Confirm tenant ID set in link.
            expect(getTenantId(link)).equal(createdTenantId);
          });
      });

      it('generateSignInWithEmailLink() should generate the link for tenant specific user', () => {
        // Generate link for sign-in to confirm it is generated in the expected
        // tenant context.
        return tenantAwareAuth.generateSignInWithEmailLink(updatedEmail, actionCodeSettings)
          .then((link) => {
            // Confirm tenant ID set in link.
            expect(getTenantId(link)).equal(createdTenantId);
          });
      });

      it('revokeRefreshTokens() should revoke the tokens for the tenant specific user', () => {
        // Revoke refresh tokens.
        // On revocation, tokensValidAfterTime will be updated to current time. All tokens issued
        // before that time will be rejected. As the underlying backend field is rounded to the nearest
        // second, we are subtracting one second.
        lastValidSinceTime = new Date().getTime() - 1000;
        return tenantAwareAuth.revokeRefreshTokens(createdUserUid)
          .then(() => {
            return tenantAwareAuth.getUser(createdUserUid);
          })
          .then((userRecord) => {
            expect(new Date(userRecord.tokensValidAfterTime).getTime())
              .to.be.greaterThan(lastValidSinceTime);
          });
      });

      it('listUsers() should list tenant specific users', () => {
        return tenantAwareAuth.listUsers(100)
          .then((listUsersResult) => {
            // Confirm expected user returned in the list and all users returned
            // belong to the expected tenant.
            const allUsersBelongToTenant =
                listUsersResult.users.every((user) => user.tenantId === createdTenantId);
            expect(allUsersBelongToTenant).to.be.true;
            const knownUserInTenant =
                listUsersResult.users.some((user) => user.uid === createdUserUid);
            expect(knownUserInTenant).to.be.true;
          });
      });

      it('deleteUser() should delete the tenant specific user', () => {
        return tenantAwareAuth.deleteUser(createdUserUid)
          .then(() => {
            return tenantAwareAuth.getUser(createdUserUid)
              .should.eventually.be.rejected.and.have.property('code', 'auth/user-not-found');
          });
      });

      it('importUsers() should upload a user to the specified tenant', () => {
        const currentHashKey = importOptions.hash.key.toString('utf8');
        const passwordHash =
            crypto.createHmac('sha256', currentHashKey).update(rawPassword + rawSalt).digest();
        const importUserRecord: any = {
          uid: createdUserUid,
          email: createdUserUid + '@example.com',
          passwordHash,
          passwordSalt: Buffer.from(rawSalt),
        };
        return tenantAwareAuth.importUsers([importUserRecord], importOptions)
          .then(() => {
            return tenantAwareAuth.getUser(createdUserUid);
          })
          .then((userRecord) => {
            // Confirm user uploaded successfully.
            expect(userRecord.tenantId).to.equal(createdTenantId);
            expect(userRecord.uid).to.equal(createdUserUid);
          });
      });
    });

    // Sanity check OIDC/SAML config management API.
    describe('SAML management APIs', () => {
      let tenantAwareAuth: admin.auth.TenantAwareAuth;
      const authProviderConfig = {
        providerId: 'saml.' + generateRandomString(5),
        displayName: 'SAML_DISPLAY_NAME1',
        enabled: true,
        idpEntityId: 'IDP_ENTITY_ID1',
        ssoURL: 'https://example.com/login1',
        x509Certificates: [mocks.x509CertPairs[0].public],
        rpEntityId: 'RP_ENTITY_ID1',
        callbackURL: 'https://projectId.firebaseapp.com/__/auth/handler',
        enableRequestSigning: true,
      };
      const modifiedConfigOptions = {
        displayName: 'SAML_DISPLAY_NAME3',
        enabled: false,
        idpEntityId: 'IDP_ENTITY_ID3',
        ssoURL: 'https://example.com/login3',
        x509Certificates: [mocks.x509CertPairs[1].public],
        rpEntityId: 'RP_ENTITY_ID3',
        callbackURL: 'https://projectId3.firebaseapp.com/__/auth/handler',
        enableRequestSigning: false,
      };

      before(function() {
        if (!createdTenantId) {
          this.skip();
        } else {
          tenantAwareAuth = admin.auth().tenantManager().authForTenant(createdTenantId);
        }
      });

      // Delete SAML configuration at the end of test suite.
      after(() => {
        if (tenantAwareAuth) {
          return tenantAwareAuth.deleteProviderConfig(authProviderConfig.providerId)
            .catch((error) => {
              // Ignore error.
            });
        }
      });

      it('should support CRUD operations', () => {
        return tenantAwareAuth.createProviderConfig(authProviderConfig)
          .then((config) => {
            assertDeepEqualUnordered(authProviderConfig, config);
            return tenantAwareAuth.getProviderConfig(authProviderConfig.providerId);
          })
          .then((config) => {
            assertDeepEqualUnordered(authProviderConfig, config);
            return tenantAwareAuth.updateProviderConfig(
              authProviderConfig.providerId, modifiedConfigOptions);
          })
          .then((config) => {
            const modifiedConfig = deepExtend(
                {providerId: authProviderConfig.providerId}, modifiedConfigOptions);
            assertDeepEqualUnordered(modifiedConfig, config);
            return tenantAwareAuth.deleteProviderConfig(authProviderConfig.providerId);
          })
          .then(() => {
            return tenantAwareAuth.getProviderConfig(authProviderConfig.providerId)
              .should.eventually.be.rejected.and.have.property('code', 'auth/configuration-not-found');
          });
        });
    });

    describe('OIDC management APIs', () => {
      let tenantAwareAuth: admin.auth.TenantAwareAuth;
      const authProviderConfig = {
        providerId: 'oidc.' + generateRandomString(5),
        displayName: 'OIDC_DISPLAY_NAME1',
        enabled: true,
        issuer: 'https://oidc.com/issuer1',
        clientId: 'CLIENT_ID1',
      };
      const modifiedConfigOptions = {
        displayName: 'OIDC_DISPLAY_NAME3',
        enabled: false,
        issuer: 'https://oidc.com/issuer3',
        clientId: 'CLIENT_ID3',
      };

      before(function() {
        if (!createdTenantId) {
          this.skip();
        } else {
          tenantAwareAuth = admin.auth().tenantManager().authForTenant(createdTenantId);
        }
      });

      // Delete OIDC configuration at the end of test suite.
      after(() => {
        if (tenantAwareAuth) {
          return tenantAwareAuth.deleteProviderConfig(authProviderConfig.providerId)
            .catch((error) => {
              // Ignore error.
            });
        }
      });

      it('should support CRUD operations', () => {
        return tenantAwareAuth.createProviderConfig(authProviderConfig)
          .then((config) => {
            assertDeepEqualUnordered(authProviderConfig, config);
            return tenantAwareAuth.getProviderConfig(authProviderConfig.providerId);
          })
          .then((config) => {
            assertDeepEqualUnordered(authProviderConfig, config);
            return tenantAwareAuth.updateProviderConfig(
              authProviderConfig.providerId, modifiedConfigOptions);
          })
          .then((config) => {
            const modifiedConfig = deepExtend(
                {providerId: authProviderConfig.providerId}, modifiedConfigOptions);
            assertDeepEqualUnordered(modifiedConfig, config);
            return tenantAwareAuth.deleteProviderConfig(authProviderConfig.providerId);
          })
          .then(() => {
            return tenantAwareAuth.getProviderConfig(authProviderConfig.providerId)
              .should.eventually.be.rejected.and.have.property('code', 'auth/configuration-not-found');
          });
        });
    });

    it('getTenant() should resolve with expected tenant', () => {
      return admin.auth().tenantManager().getTenant(createdTenantId)
        .then((actualTenant) => {
          expect(actualTenant.toJSON()).to.deep.equal(expectedCreatedTenant);
        });
    });

    it('updateTenant() should resolve with the updated tenant', () => {
      expectedUpdatedTenant.tenantId = createdTenantId;
      expectedUpdatedTenant2.tenantId = createdTenantId;
      const updatedOptions: admin.auth.UpdateTenantRequest = {
        displayName: expectedUpdatedTenant.displayName,
        emailSignInConfig: {
          enabled: false,
        },
      };
      const updatedOptions2: admin.auth.UpdateTenantRequest = {
        emailSignInConfig: {
          enabled: true,
          passwordRequired: false,
        },
      };
      return admin.auth().tenantManager().updateTenant(createdTenantId, updatedOptions)
        .then((actualTenant) => {
          expect(actualTenant.toJSON()).to.deep.equal(expectedUpdatedTenant);
          return admin.auth().tenantManager().updateTenant(createdTenantId, updatedOptions2);
        })
        .then((actualTenant) => {
          expect(actualTenant.toJSON()).to.deep.equal(expectedUpdatedTenant2);
        });
    });

    it('listTenants() should resolve with expected number of tenants', () => {
      const allTenantIds: string[] = [];
      const tenantOptions2 = deepCopy(tenantOptions);
      tenantOptions2.displayName = 'testTenant2';
      const listAllTenantIds = (tenantIds: string[], nextPageToken?: string): Promise<void> => {
        return admin.auth().tenantManager().listTenants(100, nextPageToken)
          .then((result) => {
            result.tenants.forEach((tenant) => {
              tenantIds.push(tenant.tenantId);
            });
            if (result.pageToken) {
              return listAllTenantIds(tenantIds, result.pageToken);
            }
          });
      };
      return admin.auth().tenantManager().createTenant(tenantOptions2)
        .then((actualTenant) => {
          createdTenants.push(actualTenant.tenantId);
          // Test listTenants returns the expected tenants.
          return listAllTenantIds(allTenantIds);
        })
        .then(() => {
          // All created tenants should be in the list of tenants.
          createdTenants.forEach((tenantId) => {
            expect(allTenantIds).to.contain(tenantId);
          });
        });
    });

    it('deleteTenant() should successfully delete the provided tenant', () => {
      return admin.auth().tenantManager().deleteTenant(createdTenantId)
        .then(() => {
          return admin.auth().tenantManager().getTenant(createdTenantId);
        })
        .then((result) => {
          throw new Error('unexpected success');
        })
        .catch((error) => {
          expect(error.code).to.equal('auth/tenant-not-found');
        });
    });
  });

  describe('SAML configuration operations', () => {
    const authProviderConfig1 = {
      providerId: 'saml.' + generateRandomString(5),
      displayName: 'SAML_DISPLAY_NAME1',
      enabled: true,
      idpEntityId: 'IDP_ENTITY_ID1',
      ssoURL: 'https://example.com/login1',
      x509Certificates: [mocks.x509CertPairs[0].public],
      rpEntityId: 'RP_ENTITY_ID1',
      callbackURL: 'https://projectId.firebaseapp.com/__/auth/handler',
      enableRequestSigning: true,
    };
    const authProviderConfig2 = {
      providerId: 'saml.' + generateRandomString(5),
      displayName: 'SAML_DISPLAY_NAME2',
      enabled: true,
      idpEntityId: 'IDP_ENTITY_ID2',
      ssoURL: 'https://example.com/login2',
      x509Certificates: [mocks.x509CertPairs[1].public],
      rpEntityId: 'RP_ENTITY_ID2',
      callbackURL: 'https://projectId.firebaseapp.com/__/auth/handler',
      enableRequestSigning: true,
    };

    const removeTempConfigs = () => {
      return Promise.all([
        admin.auth().deleteProviderConfig(authProviderConfig1.providerId).catch((error) => {/* empty */}),
        admin.auth().deleteProviderConfig(authProviderConfig2.providerId).catch((error) => {/* empty */}),
      ]);
    };

    // Clean up temp configurations used for test.
    before(() => {
      return removeTempConfigs().then(() => admin.auth().createProviderConfig(authProviderConfig1));
    });

    after(() => {
      return removeTempConfigs();
    });

    it('createProviderConfig() successfully creates a SAML config', () => {
      return admin.auth().createProviderConfig(authProviderConfig2)
        .then((config) => {
          assertDeepEqualUnordered(authProviderConfig2, config);
        });
    });

    it('getProviderConfig() successfully returns the expected SAML config', () => {
      return admin.auth().getProviderConfig(authProviderConfig1.providerId)
        .then((config) => {
          assertDeepEqualUnordered(authProviderConfig1, config);
        });
    });

    it('listProviderConfig() successfully returns the list of SAML providers', () => {
      const configs: AuthProviderConfig[] = [];
      const listProviders: any = (type: 'saml' | 'oidc', maxResults?: number, pageToken?: string) => {
        return admin.auth().listProviderConfigs({type, maxResults, pageToken})
          .then((result) => {
            result.providerConfigs.forEach((config: AuthProviderConfig) => {
              configs.push(config);
            });
            if (result.pageToken) {
              return listProviders(type, maxResults, result.pageToken);
            }
          });
      };
      // In case the project already has existing providers, list all configurations and then
      // check the 2 test configs are available.
      return listProviders('saml', 1)
        .then(() => {
          let index1 = 0;
          let index2 = 0;
          for (let i = 0; i < configs.length; i++) {
            if (configs[i].providerId === authProviderConfig1.providerId) {
              index1 = i;
            } else if (configs[i].providerId === authProviderConfig2.providerId) {
              index2 = i;
            }
          }
          assertDeepEqualUnordered(authProviderConfig1, configs[index1]);
          assertDeepEqualUnordered(authProviderConfig2, configs[index2]);
        });
    });

    it('updateProviderConfig() successfully overwrites a SAML config', () => {
      const modifiedConfigOptions = {
        displayName: 'SAML_DISPLAY_NAME3',
        enabled: false,
        idpEntityId: 'IDP_ENTITY_ID3',
        ssoURL: 'https://example.com/login3',
        x509Certificates: [mocks.x509CertPairs[1].public],
        rpEntityId: 'RP_ENTITY_ID3',
        callbackURL: 'https://projectId3.firebaseapp.com/__/auth/handler',
        enableRequestSigning: false,
      };
      return admin.auth().updateProviderConfig(authProviderConfig1.providerId, modifiedConfigOptions)
        .then((config) => {
          const modifiedConfig = deepExtend(
              {providerId: authProviderConfig1.providerId}, modifiedConfigOptions);
          assertDeepEqualUnordered(modifiedConfig, config);
        });
    });

    it('updateProviderConfig() successfully partially modifies a SAML config', () => {
      const deltaChanges = {
        displayName: 'SAML_DISPLAY_NAME4',
        x509Certificates: [mocks.x509CertPairs[0].public],
        // Note, currently backend has a bug where error is thrown when callbackURL is not
        // passed event though it is not required. Fix is on the way.
        callbackURL: 'https://projectId3.firebaseapp.com/__/auth/handler',
        rpEntityId: 'RP_ENTITY_ID4',
      };
      // Only above fields should be modified.
      const modifiedConfigOptions = {
        displayName: 'SAML_DISPLAY_NAME4',
        enabled: false,
        idpEntityId: 'IDP_ENTITY_ID3',
        ssoURL: 'https://example.com/login3',
        x509Certificates: [mocks.x509CertPairs[0].public],
        rpEntityId: 'RP_ENTITY_ID4',
        callbackURL: 'https://projectId3.firebaseapp.com/__/auth/handler',
        enableRequestSigning: false,
      };
      return admin.auth().updateProviderConfig(authProviderConfig1.providerId, deltaChanges)
        .then((config) => {
          const modifiedConfig = deepExtend(
              {providerId: authProviderConfig1.providerId}, modifiedConfigOptions);
          assertDeepEqualUnordered(modifiedConfig, config);
        });
    });

    it('deleteProviderConfig() successfully deletes an existing SAML config', () => {
      return admin.auth().deleteProviderConfig(authProviderConfig1.providerId).then(() => {
        return admin.auth().getProviderConfig(authProviderConfig1.providerId)
          .should.eventually.be.rejected.and.have.property('code', 'auth/configuration-not-found');
      });
    });
  });

  describe('OIDC configuration operations', () => {
    const authProviderConfig1 = {
      providerId: 'oidc.' + generateRandomString(5),
      displayName: 'OIDC_DISPLAY_NAME1',
      enabled: true,
      issuer: 'https://oidc.com/issuer1',
      clientId: 'CLIENT_ID1',
    };
    const authProviderConfig2 = {
      providerId: 'oidc.' + generateRandomString(5),
      displayName: 'OIDC_DISPLAY_NAME2',
      enabled: true,
      issuer: 'https://oidc.com/issuer2',
      clientId: 'CLIENT_ID2',
    };

    const removeTempConfigs = () => {
      return Promise.all([
        admin.auth().deleteProviderConfig(authProviderConfig1.providerId).catch((error) => {/* empty */}),
        admin.auth().deleteProviderConfig(authProviderConfig2.providerId).catch((error) => {/* empty */}),
      ]);
    };

    // Clean up temp configurations used for test.
    before(() => {
      return removeTempConfigs().then(() => admin.auth().createProviderConfig(authProviderConfig1));
    });

    after(() => {
      return removeTempConfigs();
    });

    it('createProviderConfig() successfully creates an OIDC config', () => {
      return admin.auth().createProviderConfig(authProviderConfig2)
        .then((config) => {
          assertDeepEqualUnordered(authProviderConfig2, config);
        });
    });

    it('getProviderConfig() successfully returns the expected OIDC config', () => {
      return admin.auth().getProviderConfig(authProviderConfig1.providerId)
        .then((config) => {
          assertDeepEqualUnordered(authProviderConfig1, config);
        });
    });

    it('listProviderConfig() successfully returns the list of OIDC providers', () => {
      const configs: AuthProviderConfig[] = [];
      const listProviders: any = (type: 'saml' | 'oidc', maxResults?: number, pageToken?: string) => {
        return admin.auth().listProviderConfigs({type, maxResults, pageToken})
          .then((result) => {
            result.providerConfigs.forEach((config: AuthProviderConfig) => {
              configs.push(config);
            });
            if (result.pageToken) {
              return listProviders(type, maxResults, result.pageToken);
            }
          });
      };
      // In case the project already has existing providers, list all configurations and then
      // check the 2 test configs are available.
      return listProviders('oidc', 1)
        .then(() => {
          let index1 = 0;
          let index2 = 0;
          for (let i = 0; i < configs.length; i++) {
            if (configs[i].providerId === authProviderConfig1.providerId) {
              index1 = i;
            } else if (configs[i].providerId === authProviderConfig2.providerId) {
              index2 = i;
            }
          }
          assertDeepEqualUnordered(authProviderConfig1, configs[index1]);
          assertDeepEqualUnordered(authProviderConfig2, configs[index2]);
        });
    });

    it('updateProviderConfig() successfully overwrites an OIDC config', () => {
      const modifiedConfigOptions = {
        displayName: 'OIDC_DISPLAY_NAME3',
        enabled: false,
        issuer: 'https://oidc.com/issuer3',
        clientId: 'CLIENT_ID3',
      };
      return admin.auth().updateProviderConfig(authProviderConfig1.providerId, modifiedConfigOptions)
        .then((config) => {
          const modifiedConfig = deepExtend(
            {providerId: authProviderConfig1.providerId}, modifiedConfigOptions);
          assertDeepEqualUnordered(modifiedConfig, config);
        });
    });

    it('updateProviderConfig() successfully partially modifies an OIDC config', () => {
      const deltaChanges = {
        displayName: 'OIDC_DISPLAY_NAME4',
        issuer: 'https://oidc.com/issuer4',
      };
      // Only above fields should be modified.
      const modifiedConfigOptions = {
        displayName: 'OIDC_DISPLAY_NAME4',
        enabled: false,
        issuer: 'https://oidc.com/issuer4',
        clientId: 'CLIENT_ID3',
      };
      return admin.auth().updateProviderConfig(authProviderConfig1.providerId, deltaChanges)
        .then((config) => {
          const modifiedConfig = deepExtend(
            {providerId: authProviderConfig1.providerId}, modifiedConfigOptions);
          assertDeepEqualUnordered(modifiedConfig, config);
        });
    });

    it('deleteProviderConfig() successfully deletes an existing OIDC config', () => {
      return admin.auth().deleteProviderConfig(authProviderConfig1.providerId).then(() => {
        return admin.auth().getProviderConfig(authProviderConfig1.providerId)
          .should.eventually.be.rejected.and.have.property('code', 'auth/configuration-not-found');
      });
    });
  });

  it('deleteUser() deletes the user with the given UID', () => {
    return Promise.all([
      admin.auth().deleteUser(newUserUid),
      admin.auth().deleteUser(uidFromCreateUserWithoutUid),
    ]).should.eventually.be.fulfilled;
  });

  describe('createSessionCookie()', () => {
    let expectedExp: number;
    let expectedIat: number;
    const expiresIn = 24 * 60 * 60 * 1000;
    let payloadClaims: any;
    let currentIdToken: string;
    const uid = sessionCookieUids[0];
    const uid2 = sessionCookieUids[1];
    const uid3 = sessionCookieUids[2];

    it('creates a valid Firebase session cookie', () => {
      return admin.auth().createCustomToken(uid, {admin: true, groupId: '1234'})
        .then((customToken) => firebase.auth().signInWithCustomToken(customToken))
        .then(({user}) => user.getIdToken())
        .then((idToken) => {
          currentIdToken = idToken;
          return admin.auth().verifyIdToken(idToken);
        }).then((decodedIdTokenClaims) => {
          expectedExp = Math.floor((new Date().getTime() + expiresIn) / 1000);
          payloadClaims = decodedIdTokenClaims;
          payloadClaims.iss = payloadClaims.iss.replace(
              'securetoken.google.com', 'session.firebase.google.com');
          delete payloadClaims.exp;
          delete payloadClaims.iat;
          expectedIat = Math.floor(new Date().getTime() / 1000);
          // One day long session cookie.
          return admin.auth().createSessionCookie(currentIdToken, {expiresIn});
        })
        .then((sessionCookie) => admin.auth().verifySessionCookie(sessionCookie))
        .then((decodedIdToken) => {
          // Check for expected expiration with +/-5 seconds of variation.
          expect(decodedIdToken.exp).to.be.within(expectedExp - 5, expectedExp + 5);
          expect(decodedIdToken.iat).to.be.within(expectedIat - 5, expectedIat + 5);
          // Not supported in ID token,
          delete decodedIdToken.nonce;
          // exp and iat may vary depending on network connection latency.
          delete decodedIdToken.exp;
          delete decodedIdToken.iat;
          expect(decodedIdToken).to.deep.equal(payloadClaims);
        });
    });

    it('creates a revocable session cookie', () => {
      let currentSessionCookie: string;
      return admin.auth().createCustomToken(uid2)
        .then((customToken) => firebase.auth().signInWithCustomToken(customToken))
        .then(({user}) => user.getIdToken())
        .then((idToken) => {
          // One day long session cookie.
          return admin.auth().createSessionCookie(idToken, {expiresIn});
        })
        .then((sessionCookie) => {
          currentSessionCookie = sessionCookie;
          return new Promise((resolve) => setTimeout(() => resolve(
            admin.auth().revokeRefreshTokens(uid2),
          ), 1000));
        })
        .then(() => {
          return admin.auth().verifySessionCookie(currentSessionCookie)
            .should.eventually.be.fulfilled;
        })
        .then(() => {
          return admin.auth().verifySessionCookie(currentSessionCookie, true)
            .should.eventually.be.rejected.and.have.property('code', 'auth/session-cookie-revoked');
        });
    });

    it('fails when called with a revoked ID token', () => {
      return admin.auth().createCustomToken(uid3, {admin: true, groupId: '1234'})
        .then((customToken) => firebase.auth().signInWithCustomToken(customToken))
        .then(({user}) => user.getIdToken())
        .then((idToken) => {
          currentIdToken = idToken;
          return new Promise((resolve) => setTimeout(() => resolve(
            admin.auth().revokeRefreshTokens(uid3),
          ), 1000));
        })
        .then(() => {
          return admin.auth().createSessionCookie(currentIdToken, {expiresIn})
            .should.eventually.be.rejected.and.have.property('code', 'auth/id-token-expired');
        });
    });

  });

  describe('verifySessionCookie()', () => {
    const uid = sessionCookieUids[0];
    it('fails when called with an invalid session cookie', () => {
      return admin.auth().verifySessionCookie('invalid-token')
        .should.eventually.be.rejected.and.have.property('code', 'auth/argument-error');
    });

    it('fails when called with a Firebase ID token', () => {
      return admin.auth().createCustomToken(uid)
        .then((customToken) => firebase.auth().signInWithCustomToken(customToken))
        .then(({user}) => user.getIdToken())
        .then((idToken) => {
          return admin.auth().verifySessionCookie(idToken)
            .should.eventually.be.rejected.and.have.property('code', 'auth/argument-error');
        });
    });
  });

  describe('importUsers()', () => {
    const randomUid = 'import_' + generateRandomString(20).toLowerCase();
    let importUserRecord: any;
    const rawPassword = 'password';
    const rawSalt = 'NaCl';
    // Simulate a user stored using SCRYPT being migrated to Firebase Auth via importUsers.
    // Obtained from https://github.com/firebase/scrypt.
    const scryptHashKey = 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZ' +
                          'JzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==';
    const scryptPasswordHash = 'V358E8LdWJXAO7muq0CufVpEOXaj8aFiC7T/rcaGieN04q/ZPJ0' +
                               '8WhJEHGjj9lz/2TT+/86N5VjVoc5DdBhBiw==';
    const scryptHashOptions = {
      hash: {
        algorithm: 'SCRYPT',
        key: Buffer.from(scryptHashKey, 'base64'),
        saltSeparator: Buffer.from('Bw==', 'base64'),
        rounds: 8,
        memoryCost: 14,
      },
    };

    afterEach(() => {
      return safeDelete(randomUid);
    });

    const fixtures: UserImportTest[] = [
      {
        name: 'HMAC_SHA256',
        importOptions: {
          hash: {
            algorithm: 'HMAC_SHA256',
            key: Buffer.from('secret'),
          },
        } as any,
        computePasswordHash: (userImportTest: UserImportTest): Buffer => {
          const currentHashKey = userImportTest.importOptions.hash.key.toString('utf8');
          const currentRawPassword = userImportTest.rawPassword;
          const currentRawSalt = userImportTest.rawSalt;
          return crypto.createHmac('sha256', currentHashKey)
                       .update(currentRawPassword + currentRawSalt).digest();
        },
        rawPassword,
        rawSalt,
      },
      {
        name: 'SHA256',
        importOptions: {
          hash: {
            algorithm: 'SHA256',
            rounds: 0,
          },
        } as any,
        computePasswordHash: (userImportTest: UserImportTest): Buffer => {
          const currentRawPassword = userImportTest.rawPassword;
          const currentRawSalt = userImportTest.rawSalt;
          return crypto.createHash('sha256').update(currentRawSalt + currentRawPassword).digest();
        },
        rawPassword,
        rawSalt,
      },
      {
        name: 'MD5',
        importOptions: {
          hash: {
            algorithm: 'MD5',
            rounds: 0,
          },
        } as any,
        computePasswordHash: (userImportTest: UserImportTest): Buffer => {
          const currentRawPassword = userImportTest.rawPassword;
          const currentRawSalt = userImportTest.rawSalt;
          return Buffer.from(crypto.createHash('md5')
                                   .update(currentRawSalt + currentRawPassword).digest('hex'));
        },
        rawPassword,
        rawSalt,
      },
      {
        name: 'BCRYPT',
        importOptions: {
          hash: {
            algorithm: 'BCRYPT',
          },
        } as any,
        computePasswordHash: (userImportTest: UserImportTest): Buffer => {
          return Buffer.from(bcrypt.hashSync(userImportTest.rawPassword, 10));
        },
        rawPassword,
      },
      {
        name: 'STANDARD_SCRYPT',
        importOptions: {
          hash: {
            algorithm: 'STANDARD_SCRYPT',
            memoryCost: 1024,
            parallelization: 16,
            blockSize: 8,
            derivedKeyLength: 64,
          },
        } as any,
        computePasswordHash: (userImportTest: UserImportTest): Buffer => {
          const currentRawPassword = userImportTest.rawPassword;
          const currentRawSalt = userImportTest.rawSalt;
          const N = userImportTest.importOptions.hash.memoryCost;
          const r = userImportTest.importOptions.hash.blockSize;
          const p = userImportTest.importOptions.hash.parallelization;
          const dkLen = userImportTest.importOptions.hash.derivedKeyLength;
          return Buffer.from(scrypt.hashSync(
              currentRawPassword, {N, r, p}, dkLen, Buffer.from(currentRawSalt)));
        },
        rawPassword,
        rawSalt,
      },
      {
        name: 'PBKDF2_SHA256',
        importOptions: {
          hash: {
            algorithm: 'PBKDF2_SHA256',
            rounds: 100000,
          },
        } as any,
        computePasswordHash: (userImportTest: UserImportTest): Buffer => {
          const currentRawPassword = userImportTest.rawPassword;
          const currentRawSalt = userImportTest.rawSalt;
          const currentRounds = userImportTest.importOptions.hash.rounds;
          return crypto.pbkdf2Sync(
              currentRawPassword, currentRawSalt, currentRounds, 64, 'sha256');
        },
        rawPassword,
        rawSalt,
      },
      {
        name: 'SCRYPT',
        importOptions: scryptHashOptions as any,
        computePasswordHash: (userImportTest: UserImportTest): Buffer => {
          return Buffer.from(scryptPasswordHash, 'base64');
        },
        rawPassword,
        rawSalt,
      },
    ];

    fixtures.forEach((fixture) => {
      it(`successfully imports users with ${fixture.name} to Firebase Auth.`, () => {
        importUserRecord = {
          uid: randomUid,
          email: randomUid + '@example.com',
        };
        importUserRecord.passwordHash = fixture.computePasswordHash(fixture);
        if (typeof fixture.rawSalt !== 'undefined') {
          importUserRecord.passwordSalt = Buffer.from(fixture.rawSalt);
        }
        return testImportAndSignInUser(
          importUserRecord, fixture.importOptions, fixture.rawPassword)
          .should.eventually.be.fulfilled;

      });
    });

    it('successfully imports users with multiple OAuth providers', () => {
      const uid = randomUid;
      const email = uid + '@example.com';
      const now = new Date(1476235905000).toUTCString();
      const photoURL = 'http://www.example.com/' + uid + '/photo.png';
      importUserRecord = {
        uid,
        email,
        emailVerified: true,
        displayName: 'Test User',
        photoURL,
        phoneNumber: '+15554446666',
        disabled: false,
        customClaims: {admin: true},
        metadata: {
          lastSignInTime: now,
          creationTime: now,
        },
        providerData: [
          {
            uid: uid + '-facebook',
            displayName: 'Facebook User',
            email,
            photoURL: photoURL + '?providerId=facebook.com',
            providerId: 'facebook.com',
          },
          {
            uid: uid + '-twitter',
            displayName: 'Twitter User',
            photoURL: photoURL + '?providerId=twitter.com',
            providerId: 'twitter.com',
          },
        ],
      };
      uids.push(importUserRecord.uid);
      return admin.auth().importUsers([importUserRecord])
        .then((result) => {
          expect(result.failureCount).to.equal(0);
          expect(result.successCount).to.equal(1);
          expect(result.errors.length).to.equal(0);
          return admin.auth().getUser(uid);
        }).then((userRecord) => {
          // The phone number provider will be appended to the list of accounts.
          importUserRecord.providerData.push({
            uid: importUserRecord.phoneNumber,
            providerId: 'phone',
            phoneNumber: importUserRecord.phoneNumber,
          });
          const actualUserRecord: {[key: string]: any} = userRecord.toJSON();
          for (const key of Object.keys(importUserRecord)) {
            expect(JSON.stringify(actualUserRecord[key]))
              .to.be.equal(JSON.stringify(importUserRecord[key]));
          }
        }).should.eventually.be.fulfilled;
    });

    it('fails when invalid users are provided', () => {
      const users = [
        {uid: generateRandomString(20).toLowerCase(), phoneNumber: '+1error'},
        {uid: generateRandomString(20).toLowerCase(), email: 'invalid'},
        {uid: generateRandomString(20).toLowerCase(), phoneNumber: '+1invalid'},
        {uid: generateRandomString(20).toLowerCase(), emailVerified: 'invalid'} as any,
      ];
      return admin.auth().importUsers(users)
        .then((result) => {
          expect(result.successCount).to.equal(0);
          expect(result.failureCount).to.equal(4);
          expect(result.errors.length).to.equal(4);
          expect(result.errors[0].index).to.equal(0);
          expect(result.errors[0].error.code).to.equals('auth/invalid-user-import');
          expect(result.errors[1].index).to.equal(1);
          expect(result.errors[1].error.code).to.equals('auth/invalid-email');
          expect(result.errors[2].index).to.equal(2);
          expect(result.errors[2].error.code).to.equals('auth/invalid-user-import');
          expect(result.errors[3].index).to.equal(3);
          expect(result.errors[3].error.code).to.equals('auth/invalid-email-verified');
        }).should.eventually.be.fulfilled;
    });
  });
});

/**
 * Imports the provided user record with the specified hashing options and then
 * validates the import was successful by signing in to the imported account using
 * the corresponding plain text password.
 * @param {admin.auth.UserImportRecord} importUserRecord The user record to import.
 * @param {admin.auth.UserImportOptions} importOptions The import hashing options.
 * @param {string} rawPassword The plain unhashed password string.
 * @retunr {Promise<void>} A promise that resolved on success.
 */
function testImportAndSignInUser(
    importUserRecord: any, importOptions: any, rawPassword: string): Promise<void> {
  const users = [importUserRecord];
  // Import the user record.
  return admin.auth().importUsers(users, importOptions)
    .then((result) => {
      // Verify the import result.
      expect(result.failureCount).to.equal(0);
      expect(result.successCount).to.equal(1);
      expect(result.errors.length).to.equal(0);
      // Sign in with an email and password to the imported account.
      return firebase.auth().signInWithEmailAndPassword(users[0].email, rawPassword);
    })
    .then(({user}) => {
      // Confirm successful sign-in.
      expect(user.email).to.equal(users[0].email);
      expect(user.providerData[0].providerId).to.equal('password');
    });
}

/**
 * Helper function that deletes the user with the specified phone number
 * if it exists.
 * @param {string} phoneNumber The phone number of the user to delete.
 * @return {Promise} A promise that resolves when the user is deleted
 *     or is found not to exist.
 */
function deletePhoneNumberUser(phoneNumber: string) {
  return admin.auth().getUserByPhoneNumber(phoneNumber)
    .then((userRecord) => {
      return safeDelete(userRecord.uid);
    })
    .catch((error) => {
      // Suppress user not found error.
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
    });
}

/**
 * Runs cleanup routine that could affect outcome of tests and removes any
 * intermediate users created.
 *
 * @return {Promise} A promise that resolves when test preparations are ready.
 */
function cleanup() {
  // Delete any existing users that could affect the test outcome.
  const promises: Array<Promise<void>> = [
    deletePhoneNumberUser(testPhoneNumber),
    deletePhoneNumberUser(testPhoneNumber2),
    deletePhoneNumberUser(nonexistentPhoneNumber),
    deletePhoneNumberUser(updatedPhone),
  ];
  // Delete users created for session cookie tests.
  sessionCookieUids.forEach((uid) => uids.push(uid));
  // Delete list of users for testing listUsers.
  uids.forEach((uid) => {
    // Use safeDelete to avoid getting throttled.
    promises.push(safeDelete(uid));
  });
  return Promise.all(promises);
}

/**
 * Returns the action code corresponding to the link.
 *
 * @param {string} link The link to parse for the action code.
 * @return {string} The link's corresponding action code.
 */
function getActionCode(link: string): string {
  const parsedUrl = new url.URL(link);
  return parsedUrl.searchParams.get('oobCode');
}

/**
 * Returns the continue URL corresponding to the link.
 *
 * @param {string} link The link to parse for the continue URL.
 * @return {string} The link's corresponding continue URL.
 */
function getContinueUrl(link: string): string {
  const parsedUrl = new url.URL(link);
  return parsedUrl.searchParams.get('continueUrl');
}

/**
 * Returns the tenant ID corresponding to the link.
 *
 * @param {string} link The link to parse for the tenant ID.
 * @return {string} The link's corresponding tenant ID.
 */
function getTenantId(link: string): string {
  const parsedUrl = new url.URL(link);
  return parsedUrl.searchParams.get('tenantId');
}

/**
 * Safely deletes a specificed user identified by uid. This API chains all delete
 * requests and throttles them as the Auth backend rate limits this endpoint.
 * A bulk delete API is being designed to help solve this issue.
 *
 * @param {string} uid The identifier of the user to delete.
 * @return {Promise} A promise that resolves when delete operation resolves.
 */
function safeDelete(uid: string): Promise<void> {
  // Wait for delete queue to empty.
  const deletePromise = deleteQueue
    .then(() => {
      return admin.auth().deleteUser(uid);
    })
    .catch((error) => {
      // Suppress user not found error.
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
    });
  // Suppress errors in delete queue to not spill over to next item in queue.
  deleteQueue = deletePromise.catch((error) => {
    // Do nothing.
  });
  return deletePromise;
}

/**
 * Asserts actual object is equal to expected object while ignoring key order.
 * This is useful since to.deep.equal fails when order differs.
 *
 * @param {[key: string]: any} expected object.
 * @param {[key: string]: any} actual object.
 */
function assertDeepEqualUnordered(expected: {[key: string]: any}, actual: {[key: string]: any}) {
  for (const key in expected) {
    if (expected.hasOwnProperty(key)) {
      expect(actual[key])
        .to.deep.equal(expected[key]);
    }
  }
  expect(Object.keys(actual).length).to.be.equal(Object.keys(expected).length);
}

/*
Copyright 2018,2019 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import '../../../olm-loader';
import {MemoryCryptoStore} from "../../../../src/crypto/store/memory-crypto-store";
import {MockStorageApi} from "../../../MockStorageApi";
import {logger} from "../../../../src/logger";
import {OlmDevice} from "../../../../src/crypto/OlmDevice";
import * as olmlib from "../../../../src/crypto/olmlib";
import {DeviceInfo} from "../../../../src/crypto/deviceinfo";

function makeOlmDevice() {
    const mockStorage = new MockStorageApi();
    const cryptoStore = new MemoryCryptoStore(mockStorage);
    const olmDevice = new OlmDevice(cryptoStore);
    return olmDevice;
}

async function setupSession(initiator, opponent) {
    await opponent.generateOneTimeKeys(1);
    const keys = await opponent.getOneTimeKeys();
    const firstKey = Object.values(keys['curve25519'])[0];

    const sid = await initiator.createOutboundSession(
        opponent.deviceCurve25519Key, firstKey,
    );
    return sid;
}

describe("OlmDevice", function() {
    if (!global.Olm) {
        logger.warn('Not running megolm unit tests: libolm not present');
        return;
    }

    beforeAll(function() {
        return global.Olm.init();
    });

    let aliceOlmDevice;
    let bobOlmDevice;

    beforeEach(async function() {
        aliceOlmDevice = makeOlmDevice();
        bobOlmDevice = makeOlmDevice();
        await aliceOlmDevice.init();
        await bobOlmDevice.init();
    });

    describe('olm', function() {
        it("can decrypt messages", async function() {
            const sid = await setupSession(aliceOlmDevice, bobOlmDevice);

            const ciphertext = await aliceOlmDevice.encryptMessage(
                bobOlmDevice.deviceCurve25519Key,
                sid,
                "The olm or proteus is an aquatic salamander in the family Proteidae",
            );

            const result = await bobOlmDevice.createInboundSession(
                aliceOlmDevice.deviceCurve25519Key,
                ciphertext.type,
                ciphertext.body,
            );
            expect(result.payload).toEqual(
                "The olm or proteus is an aquatic salamander in the family Proteidae",
            );
        });

        it('exports picked account and olm sessions', async function() {
            const sessionId = await setupSession(aliceOlmDevice, bobOlmDevice);

            // At the time of writing, Jest only tests with in-memory DB,
            // but I manually checked that the exported data has the same structure
            // when coming from indexed DB
            const exported = await bobOlmDevice.export();
            expect(exported).toHaveProperty('pickleKey');
            expect(exported).toHaveProperty('pickledAccount');
            expect(exported).toHaveProperty('sessions');
            // At this moment only Alice (the “initiator” in setupSession)
            // has a session
            expect(exported.sessions).toEqual([]);

            const MESSAGE = "The olm or proteus is an aquatic salamander in the family Proteidae";
            const ciphertext = await aliceOlmDevice.encryptMessage(
                bobOlmDevice.deviceCurve25519Key,
                sessionId,
                MESSAGE,
            );

            const bobRecreatedOlmDevice = makeOlmDevice();
            bobRecreatedOlmDevice.init(exported);

            const decrypted = await bobRecreatedOlmDevice.createInboundSession(
                aliceOlmDevice.deviceCurve25519Key,
                ciphertext.type,
                ciphertext.body,
            );
            expect(decrypted.payload).toEqual(MESSAGE);

            const exportedAgain = await bobRecreatedOlmDevice.export();
            expect(exportedAgain).toHaveProperty('pickleKey');
            expect(exportedAgain).toHaveProperty('pickledAccount');
            expect(exportedAgain).toHaveProperty('sessions');
            expect(Array.isArray(exportedAgain.sessions)).toBe(true);
            // this time we expect Bob to have a session to export
            expect(exportedAgain.sessions[0]).toEqual(
                expect.objectContaining({
                    session: expect.any(String),
                    lastReceivedMessageTs: expect.any(Number),
                    deviceKey: expect.any(String),
                    sessionId: expect.any(String),
                })
            );

            const MESSAGE_2 = "In contrast to most amphibians, the olm is entirely aquatic";
            const ciphertext_2 = await aliceOlmDevice.encryptMessage(
                bobOlmDevice.deviceCurve25519Key,
                sessionId,
                MESSAGE_2,
            );

            const bobRecreatedAgainOlmDevice = makeOlmDevice();
            bobRecreatedAgainOlmDevice.init(exportedAgain);

            // Note: decrypted_2 does not have the same structure than decrypted
            const decrypted_2 = await bobRecreatedAgainOlmDevice.decryptMessage(
                aliceOlmDevice.deviceCurve25519Key,
                decrypted.session_id,
                ciphertext_2.type,
                ciphertext_2.body,
            );
            expect(decrypted_2).toEqual(MESSAGE_2);

        });

        it("creates only one session at a time", async function() {
            // if we call ensureOlmSessionsForDevices multiple times, it should
            // only try to create one session at a time, even if the server is
            // slow
            let count = 0;
            const baseApis = {
                claimOneTimeKeys: () => {
                    // simulate a very slow server (.5 seconds to respond)
                    count++;
                    return new Promise((resolve, reject) => {
                        setTimeout(reject, 500);
                    });
                },
            };
            const devicesByUser = {
                "@bob:example.com": [
                    DeviceInfo.fromStorage({
                        keys: {
                            "curve25519:ABCDEFG": "akey",
                        },
                    }, "ABCDEFG"),
                ],
            };
            function alwaysSucceed(promise) {
                // swallow any exception thrown by a promise, so that
                // Promise.all doesn't abort
                return promise.catch(() => {});
            }

            // start two tasks that try to ensure that there's an olm session
            const promises = Promise.all([
                alwaysSucceed(olmlib.ensureOlmSessionsForDevices(
                    aliceOlmDevice, baseApis, devicesByUser,
                )),
                alwaysSucceed(olmlib.ensureOlmSessionsForDevices(
                    aliceOlmDevice, baseApis, devicesByUser,
                )),
            ]);

            await new Promise((resolve) => {
                setTimeout(resolve, 200);
            });

            // after .2s, both tasks should have started, but one should be
            // waiting on the other before trying to create a session, so
            // claimOneTimeKeys should have only been called once
            expect(count).toBe(1);

            await promises;

            // after waiting for both tasks to complete, the first task should
            // have failed, so the second task should have tried to create a
            // new session and will have called claimOneTimeKeys
            expect(count).toBe(2);
        });
    });
});

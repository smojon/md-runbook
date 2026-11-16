package dev.mdrunbook.hardwarekey

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * The app's SSH key in Android Keystore: a P-256 key made inside the phone's secure hardware
 * (StrongBox when there is one, else the TEE), never exported. JavaScript gets the public key and
 * signatures.
 */
class HardwareKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HardwareKey")

    AsyncFunction("publicKey") { alias: String ->
      val cert = keyStore().getCertificate(alias) ?: return@AsyncFunction null
      encodePoint(cert.publicKey as ECPublicKey)
    }

    // userPresence: each signature asks for a fingerprint or the screen lock (Android 11 and later;
    // before, the key is usable for a few seconds after the prompt); Keystore enforces it, the
    // app only shows the system's prompt.
    AsyncFunction("generate") { alias: String, userPresence: Boolean ->
      val store = keyStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
      val pair = try {
        generate(alias, strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P, userPresence = userPresence)
      } catch (e: Exception) {
        // No StrongBox on this phone (or it refused): the TEE.
        if (store.containsAlias(alias)) store.deleteEntry(alias)
        generate(alias, strongBox = false, userPresence = userPresence)
      }
      mapOf("publicKey" to encodePoint(pair.public as ECPublicKey), "hardware" to isHardware(pair.private))
    }

    AsyncFunction("sign") { alias: String, data: String, promise: Promise ->
      val bytes = Base64.decode(data, Base64.NO_WRAP)
      val key = keyStore().getKey(alias, null) as? PrivateKey ?: return@AsyncFunction promise.reject(NoKeyException(alias))
      if (authPerUse(key)) {
        // Each use asks: the prompt unlocks this one signature (a CryptoObject), nothing else.
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(key)
        confirmUser(promise, BiometricPrompt.CryptoObject(s)) { result ->
          val unlocked = result.cryptoObject?.signature ?: throw IllegalStateException("no signature from the prompt")
          unlocked.update(bytes)
          promise.resolve(Base64.encodeToString(unlocked.sign(), Base64.NO_WRAP))
        }
        return@AsyncFunction
      }
      try {
        promise.resolve(sign(alias, bytes))
      } catch (e: UserNotAuthenticatedException) {
        // A key made before (usable a few seconds after the prompt): the prompt, then sign.
        confirmUser(promise, null) { promise.resolve(sign(alias, bytes)) }
      }
    }

    AsyncFunction("remove") { alias: String ->
      val store = keyStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    AsyncFunction("isHardware") { alias: String ->
      val key = keyStore().getKey(alias, null) as? PrivateKey ?: return@AsyncFunction false
      isHardware(key)
    }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun sign(alias: String, bytes: ByteArray): String {
    val key = keyStore().getKey(alias, null) as? PrivateKey ?: throw NoKeyException(alias)
    val s = Signature.getInstance("SHA256withECDSA")
    s.initSign(key)
    s.update(bytes)
    return Base64.encodeToString(s.sign(), Base64.NO_WRAP)
  }

  /** A key that asks for the user at each use (no time after a prompt): it signs only through a CryptoObject. */
  private fun authPerUse(key: PrivateKey): Boolean {
    val info = KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
    // 0 or -1: no time after a prompt.
    @Suppress("DEPRECATION")
    val seconds = info.userAuthenticationValidityDurationSeconds
    return info.isUserAuthenticationRequired && seconds <= 0
  }

  /**
   * The system's fingerprint (or screen lock) prompt; `then` runs once the user confirmed. With
   * `crypto`, the prompt unlocks that operation only (a key that asks at each use).
   */
  private fun confirmUser(promise: Promise, crypto: BiometricPrompt.CryptoObject?, then: (BiometricPrompt.AuthenticationResult) -> Unit) {
    val activity = appContext.currentActivity as? FragmentActivity
      ?: return promise.reject(CodedException("The key needs your fingerprint, and the app is not in front"))
    activity.runOnUiThread {
      val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            try {
              then(result)
            } catch (e: Exception) {
              promise.reject(CodedException("Signing failed: ${e.message}"))
            }
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            promise.reject(CodedException("Not confirmed: $errString"))
          }
        },
      )
      // Strong biometrics or the screen lock (that pair needs Android 11; before, any biometric).
      // (Keys that ask at each use are made on Android 11 and later only, where a CryptoObject may
      // be unlocked by the screen lock too.)
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle("md-runbook")
        .setSubtitle("Use this app's SSH key")
        .setAllowedAuthenticators(allowed)
        .build()
      try {
        if (crypto != null) prompt.authenticate(info, crypto) else prompt.authenticate(info)
      } catch (e: Exception) {
        promise.reject(CodedException("The prompt could not be shown: ${e.message}"))
      }
    }
  }

  private fun generate(alias: String, strongBox: Boolean, userPresence: Boolean): java.security.KeyPair {
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
    if (userPresence) {
      spec.setUserAuthenticationRequired(true)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // 0: each signature asks (the prompt unlocks that one operation, a CryptoObject).
        spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
      } else {
        // Before Android 11 a key that asks at each use takes biometrics only, not the screen
        // lock: a few seconds after the prompt instead (one SSH login or one signature).
        @Suppress("DEPRECATION")
        spec.setUserAuthenticationValidityDurationSeconds(10)
      }
    }
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    generator.initialize(spec.build())
    return generator.generateKeyPair()
  }

  private fun isHardware(key: PrivateKey): Boolean {
    val info = KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT ||
        info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
    } else {
      @Suppress("DEPRECATION")
      info.isInsideSecureHardware
    }
  }

  /** 0x04 ‖ X ‖ Y, each coordinate 32 bytes, base64. */
  private fun encodePoint(key: ECPublicKey): String {
    val out = ByteArray(65)
    out[0] = 4
    fixed(key.w.affineX).copyInto(out, 1)
    fixed(key.w.affineY).copyInto(out, 33)
    return Base64.encodeToString(out, Base64.NO_WRAP)
  }

  private fun fixed(n: BigInteger): ByteArray {
    val b = n.toByteArray()
    return when {
      b.size == 32 -> b
      b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
      else -> ByteArray(32 - b.size) + b
    }
  }
}

class NoKeyException(alias: String) : CodedException("No key named $alias")

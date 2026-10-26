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

    // userPresence: the key is usable for a few seconds after the user confirms with a fingerprint
    // (or the screen lock); Keystore enforces it, the app only shows the system's prompt.
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
      try {
        promise.resolve(sign(alias, bytes))
      } catch (e: UserNotAuthenticatedException) {
        // The key wants the user: the system's prompt, then sign within its few seconds.
        confirmUser(promise) { promise.resolve(sign(alias, bytes)) }
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

  /** The system's fingerprint (or screen lock) prompt; `then` runs once the user confirmed. */
  private fun confirmUser(promise: Promise, then: () -> Unit) {
    val activity = appContext.currentActivity as? FragmentActivity
      ?: return promise.reject(CodedException("The key needs your fingerprint, and the app is not in front"))
    activity.runOnUiThread {
      val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            try {
              then()
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
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL
      prompt.authenticate(
        BiometricPrompt.PromptInfo.Builder()
          .setTitle("md-runbook")
          .setSubtitle("Use this app's SSH key")
          .setAllowedAuthenticators(allowed)
          .build(),
      )
    }
  }

  private fun generate(alias: String, strongBox: Boolean, userPresence: Boolean): java.security.KeyPair {
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
    if (userPresence) {
      spec.setUserAuthenticationRequired(true)
      // A few seconds after the prompt: one SSH login or one signature.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        spec.setUserAuthenticationParameters(10, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
      } else {
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

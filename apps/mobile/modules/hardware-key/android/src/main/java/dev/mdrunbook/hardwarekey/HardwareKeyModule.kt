package dev.mdrunbook.hardwarekey

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
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

    AsyncFunction("generate") { alias: String ->
      val store = keyStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
      val pair = try {
        generate(alias, strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
      } catch (e: Exception) {
        // No StrongBox on this phone (or it refused): the TEE.
        if (store.containsAlias(alias)) store.deleteEntry(alias)
        generate(alias, strongBox = false)
      }
      mapOf("publicKey" to encodePoint(pair.public as ECPublicKey), "hardware" to isHardware(pair.private))
    }

    AsyncFunction("sign") { alias: String, data: String ->
      val key = keyStore().getKey(alias, null) as? PrivateKey ?: throw NoKeyException(alias)
      val s = Signature.getInstance("SHA256withECDSA")
      s.initSign(key)
      s.update(Base64.decode(data, Base64.NO_WRAP))
      Base64.encodeToString(s.sign(), Base64.NO_WRAP)
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

  private fun generate(alias: String, strongBox: Boolean): java.security.KeyPair {
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
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

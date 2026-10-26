package dev.mdrunbook.appshortcuts

import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The app icon's long-press menu: each shortcut is an mdrunbook:// link (a route of the app),
 * which React Native's Linking and Expo Router open like any link, cold start or not.
 */
class AppShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppShortcuts")

    Function("setShortcuts") { items: List<Map<String, String>> ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return@Function
      val context = appContext.reactContext ?: return@Function
      val manager = context.getSystemService(ShortcutManager::class.java) ?: return@Function
      val icon = Icon.createWithResource(context, context.applicationInfo.icon)
      val shortcuts = items.take(manager.maxShortcutCountPerActivity).mapNotNull { item ->
        val id = item["id"] ?: return@mapNotNull null
        val title = item["title"] ?: return@mapNotNull null
        val path = item["path"] ?: return@mapNotNull null
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("mdrunbook:/" + path)).setPackage(context.packageName)
        ShortcutInfo.Builder(context, id).setShortLabel(title).setLongLabel(title).setIcon(icon).setIntent(intent).build()
      }
      manager.dynamicShortcuts = shortcuts
    }

    // The cold-start shortcut is a link here, read by Linking: nothing kept (iOS keeps one).
    Function("takeLaunchPath") { null as String? }
  }
}

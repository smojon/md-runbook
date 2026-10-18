# Nested fences

````markdown
Here is how to write a runnable block:

```sh
echo "this is NOT a cell, it is inside a markdown fence"
```
````

~~~text
```bash
echo "not a cell either"
```
~~~

````bash
cat <<'MD'
```sh
echo nested
```
MD
````

```sh
echo 'tilde inside backticks:'
echo '~~~'
```
